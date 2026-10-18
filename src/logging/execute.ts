/**
 * Executor: writes staged actions in one transaction, protected by write_ledger so a retry
 * never duplicates a write and never fails (SPEC 3).
 */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { pendingActions, writeLedger } from "../db/schema/agent.js";
import { logEntries, logGroups, sessionItems } from "../db/schema/log.js";
import { hspuLadder, plannedItems } from "../db/schema/plan.js";
import type { Db, Q, Tx } from "./db.js";
import { groupSnapshot } from "./groups.js";
import type {
  BeforeGroup,
  GroupSnapshot,
  LedgerResult,
  ResolvedEntry,
  StagedAction,
} from "./types.js";

export { groupSnapshot, lastBotGroup } from "./groups.js";

export type ExecuteResult =
  | { status: "done"; results: LedgerResult[] }
  | { status: "expired" }
  /** An edit or delete whose log is gone: nothing was written, the pending is cancelled. */
  | { status: "stale" };

/** Thrown inside the transaction to roll everything back when a target log no longer exists. */
class StaleActionError extends Error {}

type EntryField = Exclude<keyof ResolvedEntry, "setIndex">;
const ENTRY_FIELDS: EntryField[] = [
  "reps",
  "loadKg",
  "addedKg",
  "assistKg",
  "durationS",
  "distanceM",
  "padHeight",
  "rir",
  "rirPlus",
  "clean",
  "note",
];
const GROUP_FIELDS: (keyof BeforeGroup)[] = [
  "exerciseId",
  "plannedItemId",
  "subItem",
  "hspuStepId",
  "note",
];

/** Per set, the entry fields whose value differs between two versions of the same group. */
function changedEntryFields(
  before: ResolvedEntry[],
  after: ResolvedEntry[],
): Map<number, EntryField[]> {
  const out = new Map<number, EntryField[]>();
  for (const b of before) {
    const a = after.find((x) => x.setIndex === b.setIndex);
    if (!a) continue;
    const fields = ENTRY_FIELDS.filter((f) => a[f] !== b[f]);
    if (fields.length > 0) out.set(b.setIndex, fields);
  }
  return out;
}

function pickFields(e: ResolvedEntry, fields: EntryField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, e[f]]));
}

const entryValues = (groupId: number, e: ResolvedEntry) => ({
  groupId,
  setIndex: e.setIndex,
  reps: e.reps,
  loadKg: e.loadKg,
  addedKg: e.addedKg,
  assistKg: e.assistKg,
  durationS: e.durationS,
  distanceM: e.distanceM,
  padHeight: e.padHeight,
  rir: e.rir,
  rirPlus: e.rirPlus,
  clean: e.clean,
  note: e.note,
});

async function ladderId(q: Q, slug: string | undefined | null): Promise<number | null> {
  if (!slug) return null;
  const [row] = await q
    .select({ id: hspuLadder.id })
    .from(hspuLadder)
    .where(eq(hspuLadder.slug, slug));
  return row?.id ?? null;
}

async function markItemDone(
  q: Q,
  sessionDate: string,
  plannedItemId: number,
  exerciseId: number,
): Promise<void> {
  await q
    .insert(sessionItems)
    .values({
      sessionDate,
      plannedItemId,
      status: "done",
      chosenExerciseId: exerciseId,
      source: "bot",
    })
    .onConflictDoUpdate({
      target: [sessionItems.sessionDate, sessionItems.plannedItemId],
      set: { status: "done", chosenExerciseId: exerciseId, source: "bot" },
    });
}

/** Removes the bot-made session_items row when no group is left for that planned item. */
async function cleanupSessionItem(
  q: Q,
  sessionDate: string,
  plannedItemId: number | null,
): Promise<void> {
  if (plannedItemId === null) return;
  const [other] = await q
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(and(eq(logGroups.sessionDate, sessionDate), eq(logGroups.plannedItemId, plannedItemId)))
    .limit(1);
  if (other) return;
  await q
    .delete(sessionItems)
    .where(
      and(
        eq(sessionItems.sessionDate, sessionDate),
        eq(sessionItems.plannedItemId, plannedItemId),
        eq(sessionItems.source, "bot"),
      ),
    );
}

const groupFields = (g: typeof logGroups.$inferSelect): BeforeGroup => ({
  exerciseId: g.exerciseId,
  plannedItemId: g.plannedItemId,
  subItem: g.subItem,
  hspuStepId: g.hspuStepId,
  note: g.note,
});

async function writeAction(tx: Tx, a: StagedAction, now: Date): Promise<LedgerResult> {
  switch (a.kind) {
    case "log_sets": {
      const r = a.resolved;
      const [g] = await tx
        .insert(logGroups)
        .values({
          sessionDate: r.sessionDate,
          performedAt: now,
          plannedItemId: r.plannedItem?.id ?? null,
          subItem: r.plannedItem?.subItem ?? 0,
          exerciseId: r.exercise.id,
          bwKg: r.bwKg,
          source: "text",
          note: r.note,
          hspuStepId: await ladderId(tx, r.hspuStep?.slug),
        })
        .returning({ id: logGroups.id });
      const groupId = (g as { id: number }).id;
      if (r.entries.length > 0) {
        await tx.insert(logEntries).values(r.entries.map((e) => entryValues(groupId, e)));
      }
      if (r.plannedItem) await markItemDone(tx, r.sessionDate, r.plannedItem.id, r.exercise.id);
      return { kind: "log", groupId };
    }
    case "edit_group": {
      const gid = a.before.groupId;
      const [g] = await tx.select().from(logGroups).where(eq(logGroups.id, gid));
      const current = await groupSnapshot(tx, gid);
      if (!g || !current) throw new StaleActionError(`Log group ${gid} no longer exists.`);
      const beforeGroup = groupFields(g);
      // Only what the edit changed is written, so a RIR set by a button in between survives.
      const exerciseChanged = a.after.exercise.id !== a.before.exercise.id;
      const stepChanged = a.after.hspuStep?.slug !== a.before.hspuStep?.slug;
      const newPlanned = a.after.plannedItemId;
      const groupSet: Record<string, unknown> = {};
      if (exerciseChanged) {
        let subItem = g.subItem;
        if (newPlanned !== g.plannedItemId) {
          const [p] =
            newPlanned === null
              ? []
              : await tx
                  .select({ subItem: plannedItems.subItem })
                  .from(plannedItems)
                  .where(eq(plannedItems.id, newPlanned));
          subItem = p?.subItem ?? 0;
        }
        Object.assign(groupSet, {
          exerciseId: a.after.exercise.id,
          plannedItemId: newPlanned,
          subItem,
        });
      }
      if (stepChanged) groupSet.hspuStepId = await ladderId(tx, a.after.hspuStep?.slug);
      if (a.input.changes.note !== undefined) groupSet.note = a.input.changes.note;
      if (Object.keys(groupSet).length > 0) {
        await tx.update(logGroups).set(groupSet).where(eq(logGroups.id, gid));
      }
      for (const [setIndex, fields] of changedEntryFields(a.before.entries, a.after.entries)) {
        const e = a.after.entries.find((x) => x.setIndex === setIndex) as ResolvedEntry;
        await tx
          .update(logEntries)
          .set(pickFields(e, fields))
          .where(and(eq(logEntries.groupId, gid), eq(logEntries.setIndex, setIndex)));
      }
      if (exerciseChanged && newPlanned !== g.plannedItemId) {
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId);
      }
      if (exerciseChanged && newPlanned !== null) {
        await markItemDone(tx, g.sessionDate, newPlanned, a.after.exercise.id);
      }
      const [g2] = await tx.select().from(logGroups).where(eq(logGroups.id, gid));
      const updated = await groupSnapshot(tx, gid);
      const result: LedgerResult = {
        kind: "edit",
        groupId: gid,
        before: current.entries,
        beforeGroup,
        after: updated?.entries ?? a.after.entries,
        afterGroup: g2 ? groupFields(g2) : undefined,
      };
      return result;
    }
    case "delete_group": {
      const snap = await deleteGroup(tx, a.snapshot.groupId);
      if (!snap) throw new StaleActionError(`Log group ${a.snapshot.groupId} no longer exists.`);
      return { kind: "delete", snapshot: snap };
    }
    case "clarify_exercise":
      throw new Error("A clarify_exercise action cannot be executed.");
  }
}

/** Deletes a group (entries cascade) and its bot session_items row if unused. */
async function deleteGroup(q: Q, groupId: number): Promise<GroupSnapshot | null> {
  const snap = await groupSnapshot(q, groupId);
  if (!snap) return null;
  await q.delete(logGroups).where(eq(logGroups.id, groupId));
  await cleanupSessionItem(q, snap.sessionDate, snap.plannedItemId);
  return snap;
}

export async function executeActions(
  db: Db,
  sourceKey: string,
  actions: StagedAction[],
  opts: { pendingId?: number; now?: Date } = {},
): Promise<ExecuteResult> {
  const now = opts.now ?? new Date();
  try {
    return await runActions(db, sourceKey, actions, opts, now);
  } catch (error) {
    if (!(error instanceof StaleActionError)) throw error;
    // The transaction rolled back (including the pending claim): close the request for good.
    if (opts.pendingId !== undefined) {
      await db
        .update(pendingActions)
        .set({ status: "cancelled" })
        .where(and(eq(pendingActions.id, opts.pendingId), eq(pendingActions.status, "open")));
    }
    return { status: "stale" };
  }
}

function runActions(
  db: Db,
  sourceKey: string,
  actions: StagedAction[],
  opts: { pendingId?: number },
  now: Date,
): Promise<ExecuteResult> {
  return db.transaction(async (tx): Promise<ExecuteResult> => {
    if (opts.pendingId !== undefined) {
      const claimed = await tx
        .update(pendingActions)
        .set({ status: "executed" })
        .where(
          and(
            eq(pendingActions.id, opts.pendingId),
            eq(pendingActions.status, "open"),
            gt(pendingActions.expiresAt, now),
          ),
        )
        .returning({ id: pendingActions.id });
      if (claimed.length === 0) {
        // A retry after ✅ (the handler ran twice): the writes are in the ledger, report them.
        const [p] = await tx
          .select({ status: pendingActions.status })
          .from(pendingActions)
          .where(eq(pendingActions.id, opts.pendingId));
        if (p?.status === "executed") {
          const rows = await tx
            .select({ result: writeLedger.result })
            .from(writeLedger)
            .where(eq(writeLedger.sourceKey, sourceKey))
            .orderBy(asc(writeLedger.actionIndex));
          if (rows.length > 0) return { status: "done", results: rows.map((r) => r.result) };
        }
        return { status: "expired" };
      }
    }
    const results: LedgerResult[] = [];
    for (const [i, action] of actions.entries()) {
      const placeholder: LedgerResult = { kind: "log", groupId: 0 };
      const inserted = await tx
        .insert(writeLedger)
        .values({ sourceKey, actionIndex: i, result: placeholder })
        .onConflictDoNothing()
        .returning({ i: writeLedger.actionIndex });
      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ result: writeLedger.result })
          .from(writeLedger)
          .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, i)));
        results.push((existing as { result: LedgerResult }).result);
        continue;
      }
      const result = await writeAction(tx, action, now);
      await tx
        .update(writeLedger)
        .set({ result })
        .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, i)));
      results.push(result);
    }
    return { status: "done", results };
  });
}

/** Results already stored for a source key, in action order (empty when none). */
export async function ledgerResults(db: Q, sourceKey: string): Promise<LedgerResult[]> {
  const rows = await db
    .select({ result: writeLedger.result })
    .from(writeLedger)
    .where(eq(writeLedger.sourceKey, sourceKey))
    .orderBy(asc(writeLedger.actionIndex));
  return rows.map((r) => r.result);
}

/** Removes a group. Returns its snapshot, or null when it was already gone. */
export async function undoGroup(db: Db, groupId: number): Promise<GroupSnapshot | null> {
  return db.transaction((tx) => deleteGroup(tx, groupId));
}

export type UndoEditResult =
  | { status: "undone"; snapshot: GroupSnapshot }
  /** The log was changed after the edit, so restoring would overwrite newer values. */
  | { status: "stale" }
  | { status: "none" };

/**
 * Restores what an edit changed, but only while those fields still hold the edit's values
 * (other fields, e.g. a RIR set later, don't matter). Safe to repeat.
 */
export async function undoEdit(
  db: Db,
  sourceKey: string,
  actionIndex: number,
): Promise<UndoEditResult> {
  return db.transaction(async (tx): Promise<UndoEditResult> => {
    const [row] = await tx
      .select({ result: writeLedger.result })
      .from(writeLedger)
      .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, actionIndex)));
    const result = row?.result;
    if (result?.kind !== "edit") return { status: "none" };
    const gid = result.groupId;
    const [g] = await tx.select().from(logGroups).where(eq(logGroups.id, gid));
    if (!g) return { status: "none" };
    const bg = result.beforeGroup;
    const ag = result.afterGroup;
    const current = await groupSnapshot(tx, gid);
    if (!current) return { status: "none" };

    // Edits recorded without after-values (older rows) restore everything.
    const groupDiff = bg ? (ag ? GROUP_FIELDS.filter((k) => bg[k] !== ag[k]) : GROUP_FIELDS) : [];
    const entryDiff = result.after
      ? changedEntryFields(result.before, result.after)
      : new Map(result.before.map((e) => [e.setIndex, ENTRY_FIELDS]));
    if (result.after && ag) {
      const curGroup = groupFields(g);
      const holds = (group: BeforeGroup, entries: ResolvedEntry[]) =>
        groupDiff.every((k) => curGroup[k] === group[k]) &&
        [...entryDiff].every(([i, fields]) => {
          const cur = current.entries.find((e) => e.setIndex === i);
          const ref = entries.find((e) => e.setIndex === i);
          return cur !== undefined && ref !== undefined && fields.every((f) => cur[f] === ref[f]);
        });
      if (!holds(ag, result.after)) {
        // Already restored (a repeated tap) is fine; anything else changed since.
        if (bg && holds(bg, result.before)) return { status: "undone", snapshot: current };
        return { status: "stale" };
      }
    }

    if (bg && groupDiff.length > 0) {
      await tx
        .update(logGroups)
        .set(Object.fromEntries(groupDiff.map((k) => [k, bg[k]])))
        .where(eq(logGroups.id, gid));
      if (groupDiff.includes("plannedItemId") && bg.plannedItemId !== g.plannedItemId) {
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId);
        if (bg.plannedItemId !== null) {
          await markItemDone(tx, g.sessionDate, bg.plannedItemId, bg.exerciseId);
        }
      } else if (groupDiff.includes("exerciseId") && bg.plannedItemId !== null) {
        // Same planned item, other exercise (OR item): the choice recorded on it goes back too.
        await tx
          .update(sessionItems)
          .set({ chosenExerciseId: bg.exerciseId })
          .where(
            and(
              eq(sessionItems.sessionDate, g.sessionDate),
              eq(sessionItems.plannedItemId, bg.plannedItemId),
            ),
          );
      }
    }
    for (const [setIndex, fields] of entryDiff) {
      const e = result.before.find((x) => x.setIndex === setIndex);
      if (!e) continue;
      await tx
        .update(logEntries)
        .set(pickFields(e, fields))
        .where(and(eq(logEntries.groupId, gid), eq(logEntries.setIndex, setIndex)));
    }
    const snapshot = await groupSnapshot(tx, gid);
    return snapshot ? { status: "undone", snapshot } : { status: "none" };
  });
}

/** The RIR buttons: sets RIR on the last set of the group. */
export async function setLastSetRir(
  db: Db,
  groupId: number,
  rir: number,
  plus: boolean,
): Promise<GroupSnapshot | null> {
  const [last] = await db
    .select({ id: logEntries.id })
    .from(logEntries)
    .where(eq(logEntries.groupId, groupId))
    .orderBy(desc(logEntries.setIndex))
    .limit(1);
  if (!last) return null;
  await db.update(logEntries).set({ rir, rirPlus: plus }).where(eq(logEntries.id, last.id));
  return groupSnapshot(db, groupId);
}

/** The clean buttons: applies to every set of the group. */
export async function setGroupClean(
  db: Db,
  groupId: number,
  clean: boolean,
): Promise<GroupSnapshot | null> {
  const rows = await db
    .update(logEntries)
    .set({ clean })
    .where(eq(logEntries.groupId, groupId))
    .returning({ id: logEntries.id });
  return rows.length === 0 ? null : groupSnapshot(db, groupId);
}
