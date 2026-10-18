/**
 * Executor: writes staged actions in one transaction, protected by write_ledger so a retry
 * never duplicates a write and never fails (SPEC 3).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { pendingActions, writeLedger } from "../db/schema/agent.js";
import { logEntries, logGroups, sessionItems } from "../db/schema/log.js";
import { hspuLadder, plannedItems } from "../db/schema/plan.js";
import type { Db, Q, Tx } from "./db.js";
import { groupSnapshot } from "./groups.js";
import type { GroupSnapshot, LedgerResult, ResolvedEntry, StagedAction } from "./types.js";

export { groupSnapshot, lastBotGroup } from "./groups.js";

export type ExecuteResult = { status: "done"; results: LedgerResult[] } | { status: "expired" };

/** Extra data kept in an edit's ledger result so an undo can restore group-level fields too. */
interface BeforeGroup {
  exerciseId: number;
  plannedItemId: number | null;
  subItem: number;
  hspuStepId: number | null;
  note: string | null;
}
type EditLedger = Extract<LedgerResult, { kind: "edit" }> & { beforeGroup?: BeforeGroup };

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
      if (!g || !current) throw new Error(`Log group ${gid} no longer exists.`);
      const beforeGroup: BeforeGroup = {
        exerciseId: g.exerciseId,
        plannedItemId: g.plannedItemId,
        subItem: g.subItem,
        hspuStepId: g.hspuStepId,
        note: g.note,
      };
      const newPlanned = a.after.plannedItemId;
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
      await tx
        .update(logGroups)
        .set({
          exerciseId: a.after.exercise.id,
          plannedItemId: newPlanned,
          subItem,
          hspuStepId: await ladderId(tx, a.after.hspuStep?.slug),
          ...(a.input.changes.note !== undefined ? { note: a.input.changes.note } : {}),
        })
        .where(eq(logGroups.id, gid));
      for (const e of a.after.entries) {
        const { groupId: _g, setIndex: _s, ...rest } = entryValues(gid, e);
        await tx
          .update(logEntries)
          .set(rest)
          .where(and(eq(logEntries.groupId, gid), eq(logEntries.setIndex, e.setIndex)));
      }
      if (newPlanned !== g.plannedItemId) {
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId);
      }
      if (newPlanned !== null) {
        await markItemDone(tx, g.sessionDate, newPlanned, a.after.exercise.id);
      }
      const result: EditLedger = {
        kind: "edit",
        groupId: gid,
        before: current.entries,
        beforeGroup,
      };
      return result;
    }
    case "delete_group": {
      const snap = (await deleteGroup(tx, a.snapshot.groupId)) ?? a.snapshot;
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
  return db.transaction(async (tx): Promise<ExecuteResult> => {
    if (opts.pendingId !== undefined) {
      const claimed = await tx
        .update(pendingActions)
        .set({ status: "executed" })
        .where(
          and(
            eq(pendingActions.id, opts.pendingId),
            eq(pendingActions.status, "open"),
            sql`${pendingActions.expiresAt} > now()`,
          ),
        )
        .returning({ id: pendingActions.id });
      if (claimed.length === 0) return { status: "expired" };
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

/** Removes a group. Returns its snapshot, or null when it was already gone. */
export async function undoGroup(db: Db, groupId: number): Promise<GroupSnapshot | null> {
  return db.transaction((tx) => deleteGroup(tx, groupId));
}

/** Restores the before-values stored in the ledger. Safe to repeat. Null when nothing to restore. */
export async function undoEdit(
  db: Db,
  sourceKey: string,
  actionIndex: number,
): Promise<GroupSnapshot | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ result: writeLedger.result })
      .from(writeLedger)
      .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, actionIndex)));
    const result = row?.result as EditLedger | undefined;
    if (result?.kind !== "edit") return null;
    const gid = result.groupId;
    const [g] = await tx.select().from(logGroups).where(eq(logGroups.id, gid));
    if (!g) return null;
    const bg = result.beforeGroup;
    if (bg) {
      await tx
        .update(logGroups)
        .set({
          exerciseId: bg.exerciseId,
          plannedItemId: bg.plannedItemId,
          subItem: bg.subItem,
          hspuStepId: bg.hspuStepId,
          note: bg.note,
        })
        .where(eq(logGroups.id, gid));
      if (bg.plannedItemId !== g.plannedItemId) {
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId);
        if (bg.plannedItemId !== null) {
          await markItemDone(tx, g.sessionDate, bg.plannedItemId, bg.exerciseId);
        }
      }
    }
    for (const e of result.before) {
      const { groupId: _g, setIndex: _s, ...rest } = entryValues(gid, e);
      await tx
        .update(logEntries)
        .set(rest)
        .where(and(eq(logEntries.groupId, gid), eq(logEntries.setIndex, e.setIndex)));
    }
    return groupSnapshot(tx, gid);
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
