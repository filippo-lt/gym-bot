/**
 * Executor: writes staged actions in one transaction, protected by write_ledger so a retry
 * never duplicates a write and never fails (SPEC 3).
 */
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { memoryItems, pendingActions, writeLedger } from "../db/schema/agent.js";
import {
  bodyweightLogs,
  classLogs,
  logEntries,
  logGroups,
  sessionItems,
} from "../db/schema/log.js";
import { equipment, hspuLadder, plannedItems } from "../db/schema/plan.js";
import { readinessLogs } from "../db/schema/progression.js";
import { trainingDate } from "../domain/calendar.js";
import { loadFrozenLevel } from "../progression/load-history.js";
import { ensureSuggestions, freezeReadiness, refreshUserState } from "../progression/store.js";
import type { Db, Q, Tx } from "./db.js";
import { groupSnapshot, storedSuggestion } from "./groups.js";
import { writeSkip } from "./skip.js";
import type {
  BeforeGroup,
  GroupSnapshot,
  InputSource,
  LedgerResult,
  ResolvedEntry,
  SessionItemBefore,
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
  "band",
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
  band: e.band,
});

async function ladderId(q: Q, slug: string | undefined | null): Promise<number | null> {
  if (!slug) return null;
  const [row] = await q
    .select({ id: hspuLadder.id })
    .from(hspuLadder)
    .where(eq(hspuLadder.slug, slug));
  return row?.id ?? null;
}

/**
 * Marks the planned item done and returns the row as it was (null = none). An existing row keeps
 * its source: an imported "done" must stay imported, so Undo can never delete it.
 */
async function markItemDone(
  q: Q,
  sessionDate: string,
  plannedItemId: number,
  exerciseId: number,
): Promise<SessionItemBefore | null> {
  const key = and(
    eq(sessionItems.sessionDate, sessionDate),
    eq(sessionItems.plannedItemId, plannedItemId),
  );
  const [existing] = await q
    .select({
      status: sessionItems.status,
      chosenExerciseId: sessionItems.chosenExerciseId,
      source: sessionItems.source,
    })
    .from(sessionItems)
    .where(key);
  if (existing) {
    await q.update(sessionItems).set({ status: "done", chosenExerciseId: exerciseId }).where(key);
    return existing;
  }
  await q
    .insert(sessionItems)
    .values({
      sessionDate,
      plannedItemId,
      status: "done",
      chosenExerciseId: exerciseId,
      source: "bot",
    })
    .onConflictDoNothing();
  return null;
}

/**
 * The session_items state a group's planned item had before the bot marked it done, from the
 * ledger (the log, or the edit that moved the group onto this item). undefined = not recorded.
 */
async function recordedItemBefore(
  q: Q,
  groupId: number,
  plannedItemId: number,
): Promise<SessionItemBefore | null | undefined> {
  const rows = await q
    .select({ result: writeLedger.result })
    .from(writeLedger)
    .where(sql`${writeLedger.result}->>'groupId' = ${String(groupId)}`)
    .orderBy(desc(writeLedger.createdAt));
  for (const { result } of rows) {
    if (result.kind === "log" && (result.plannedItemId ?? plannedItemId) === plannedItemId) {
      return result.sessionItemBefore;
    }
    if (
      result.kind === "edit" &&
      result.sessionItemBefore !== undefined &&
      result.beforeGroup?.plannedItemId !== plannedItemId &&
      result.afterGroup?.plannedItemId === plannedItemId
    ) {
      return result.sessionItemBefore;
    }
  }
  return undefined;
}

/**
 * Undoes markItemDone when no group is left for that planned item: a row that did not exist
 * before is deleted (bot rows only), one that did is put back as it was. Without a record
 * (legacy ledger rows) only a bot row is deleted, so an imported one always survives.
 */
async function cleanupSessionItem(
  q: Q,
  sessionDate: string,
  plannedItemId: number | null,
  before?: SessionItemBefore | null,
): Promise<void> {
  if (plannedItemId === null) return;
  const [other] = await q
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(and(eq(logGroups.sessionDate, sessionDate), eq(logGroups.plannedItemId, plannedItemId)))
    .limit(1);
  if (other) return;
  const key = and(
    eq(sessionItems.sessionDate, sessionDate),
    eq(sessionItems.plannedItemId, plannedItemId),
  );
  if (before) {
    await q
      .update(sessionItems)
      .set({ status: before.status, chosenExerciseId: before.chosenExerciseId })
      .where(key);
    return;
  }
  await q.delete(sessionItems).where(and(key, eq(sessionItems.source, "bot")));
}

const groupFields = (g: typeof logGroups.$inferSelect): BeforeGroup => ({
  exerciseId: g.exerciseId,
  plannedItemId: g.plannedItemId,
  subItem: g.subItem,
  hspuStepId: g.hspuStepId,
  note: g.note,
});

async function writeAction(
  tx: Tx,
  a: StagedAction,
  now: Date,
  source: InputSource = "text",
): Promise<LedgerResult> {
  switch (a.kind) {
    case "log_sets": {
      const r = a.resolved;
      // The suggestion shown for this item/option and the day's frozen readiness (SPEC 5.2, 5.6c).
      const suggestion = r.plannedItem
        ? await storedSuggestion(
            tx,
            r.sessionDate,
            r.plannedItem.id,
            r.plannedItem.subItem,
            r.exercise.id,
          )
        : null;
      const [g] = await tx
        .insert(logGroups)
        .values({
          sessionDate: r.sessionDate,
          performedAt: now,
          plannedItemId: r.plannedItem?.id ?? null,
          subItem: r.plannedItem?.subItem ?? 0,
          exerciseId: r.exercise.id,
          suggestionId: suggestion?.id ?? null,
          // The level frozen for the group's own session day; a make-up never takes today's.
          readinessLevel: await loadFrozenLevel(tx, r.sessionDate),
          bwKg: r.bwKg,
          source,
          note: r.note,
          hspuStepId: await ladderId(tx, r.hspuStep?.slug),
        })
        .returning({ id: logGroups.id });
      const groupId = (g as { id: number }).id;
      if (r.entries.length > 0) {
        await tx.insert(logEntries).values(r.entries.map((e) => entryValues(groupId, e)));
      }
      if (!r.plannedItem) return { kind: "log", groupId, plannedItemId: null };
      const sessionItemBefore = await markItemDone(
        tx,
        r.sessionDate,
        r.plannedItem.id,
        r.exercise.id,
      );
      return { kind: "log", groupId, plannedItemId: r.plannedItem.id, sessionItemBefore };
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
        // The suggestion belonged to the old exercise: drift must not compare against it.
        Object.assign(groupSet, {
          exerciseId: a.after.exercise.id,
          plannedItemId: newPlanned,
          subItem,
          suggestionId: null,
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
      if (exerciseChanged && newPlanned !== g.plannedItemId && g.plannedItemId !== null) {
        const old = await recordedItemBefore(tx, gid, g.plannedItemId);
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId, old);
      }
      let movedOnto: SessionItemBefore | null | undefined;
      if (exerciseChanged && newPlanned !== null) {
        const prior = await markItemDone(tx, g.sessionDate, newPlanned, a.after.exercise.id);
        // Only a move onto another item has a "before" to restore; on the same item the log's own
        // record still holds.
        if (newPlanned !== g.plannedItemId) movedOnto = prior;
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
        ...(movedOnto !== undefined ? { sessionItemBefore: movedOnto } : {}),
      };
      return result;
    }
    case "delete_group": {
      const snap = await deleteGroup(tx, a.snapshot.groupId);
      if (!snap) throw new StaleActionError(`Log group ${a.snapshot.groupId} no longer exists.`);
      return { kind: "delete", snapshot: snap };
    }
    case "save_memory": {
      const [m] = await tx
        .insert(memoryItems)
        .values({
          kind: a.input.kind,
          content: a.input.content,
          structured: null,
          confirmed: true,
          active: true,
        })
        .returning({ id: memoryItems.id });
      return {
        kind: "memory",
        memoryId: (m as { id: number }).id,
        memoryKind: a.input.kind,
        content: a.input.content,
      };
    }
    case "set_band_kg": {
      const [row] = await tx
        .select({ bands: equipment.bands })
        .from(equipment)
        .where(eq(equipment.slug, a.equipmentSlug));
      if (!row) throw new Error(`Equipment ${a.equipmentSlug} not found.`);
      const bands = row.bands ?? {};
      await tx
        .update(equipment)
        .set({ bands: { ...bands, [a.input.colour]: a.input.kg } })
        .where(eq(equipment.slug, a.equipmentSlug));
      return {
        kind: "band",
        colour: a.input.colour,
        kg: a.input.kg,
        previousKg: bands[a.input.colour] ?? null,
        equipmentSlug: a.equipmentSlug,
      };
    }
    case "log_readiness": {
      // A /readiness tap carries its button; chat words map to the chat kinds.
      const kind = a.button ? BUTTON_KIND[a.button] : READINESS_KIND[a.input.signal];
      const [row] = await tx
        .insert(readinessLogs)
        .values({ date: a.date, at: now, kind, source: a.button ? "button" : "chat" })
        .returning({ id: readinessLogs.id });
      return {
        kind: "readiness",
        id: (row as { id: number }).id,
        date: a.date,
        signal: a.button ? BUTTON_WORD[a.button] : a.input.signal,
      };
    }
    case "log_bodyweight": {
      const [prev] = await tx
        .select({ id: bodyweightLogs.id, kg: bodyweightLogs.kg })
        .from(bodyweightLogs)
        .where(eq(bodyweightLogs.date, a.date));
      const [row] = await tx
        .insert(bodyweightLogs)
        .values({ date: a.date, kg: a.input.kg, source: "bot" })
        .onConflictDoUpdate({
          target: bodyweightLogs.date,
          set: { kg: a.input.kg, source: "bot" },
        })
        .returning({ id: bodyweightLogs.id });
      return {
        kind: "bodyweight",
        id: (row as { id: number }).id,
        date: a.date,
        kg: a.input.kg,
        previousKg: prev?.kg ?? null,
      };
    }
    case "log_class": {
      const heavy = a.input.heavy_groups ?? [];
      const [prev] = await tx
        .select({
          id: classLogs.id,
          heavy: classLogs.heavyGroups,
          parsed: classLogs.parsed,
          photoFileId: classLogs.photoFileId,
          rawText: classLogs.rawText,
        })
        .from(classLogs)
        .where(eq(classLogs.date, a.date));
      // Heavy-only touches just heavy_groups: moves and photo from an earlier write stay.
      const moves = a.input.moves
        ? {
            parsed: { moves: a.input.moves },
            photoFileId: a.photoFileId ?? null,
            rawText: a.rawText ?? null,
          }
        : {};
      const [row] = await tx
        .insert(classLogs)
        .values({ date: a.date, heavyGroups: heavy, source: "bot", ...moves })
        .onConflictDoUpdate({
          target: classLogs.date,
          set: { heavyGroups: heavy, source: "bot", ...moves },
        })
        .returning({ id: classLogs.id });
      return {
        kind: "class",
        id: (row as { id: number }).id,
        date: a.date,
        heavyGroups: heavy,
        ...(a.input.moves ? { moveCount: a.input.moves.length } : {}),
        previousGroups: prev?.heavy ?? null,
        written: {
          parsed: a.input.moves ? moves.parsed : (prev?.parsed ?? null),
          photoFileId: a.input.moves ? (moves.photoFileId ?? null) : (prev?.photoFileId ?? null),
          rawText: a.input.moves ? (moves.rawText ?? null) : (prev?.rawText ?? null),
        },
        previousRow: prev
          ? {
              heavyGroups: prev.heavy,
              parsed: prev.parsed ?? null,
              photoFileId: prev.photoFileId,
              rawText: prev.rawText,
            }
          : null,
      };
    }
    case "skip_items":
      return writeSkip(tx, a);
    case "clarify_exercise":
      throw new Error("A clarify_exercise action cannot be executed.");
  }
}

/**
 * A new readiness signal moves the day's level only when it is already frozen and nothing is logged yet. Otherwise the
 * first log, or /today after 05:00, freezes it later from all signals (SPEC 5.6c).
 */
export async function refreezeIfFrozen(db: Db, date: string, now: Date): Promise<void> {
  if ((await loadFrozenLevel(db, date)) === null) return;
  await freezeReadiness(db, date, now, { refreeze: true });
}

const BUTTON_WORD = { t: "tired", o: "ok", s: "strong" } as const;
const BUTTON_KIND = { t: "button_tired", o: "button_ok", s: "button_strong" } as const;

const READINESS_KIND = {
  bad_sleep: "chat_bad_sleep",
  sore: "chat_sore",
  exhausted: "chat_exhausted",
  good: "button_strong",
} as const;

/**
 * Before a log is written: freeze the day's readiness at the first log and make sure today's suggestions are stored,
 * so the group can reference them (SPEC 5.2, 5.6c). Idempotent, outside the write transaction; an engine failure never
 * blocks logging (the group is then saved without a suggestion).
 */
async function prepareProgression(db: Db, now: Date, actions: StagedAction[]): Promise<void> {
  const logs = actions.filter((a) => a.kind === "log_sets");
  if (logs.length === 0) return;
  const today = trainingDate(now);
  try {
    // Only a log for today's own session starts (and freezes) today's readiness.
    if (logs.some((a) => a.resolved.sessionDate === today)) await freezeReadiness(db, today, now);
    if (logs.some((a) => a.resolved.plannedItem && a.resolved.sessionDate === today)) {
      await ensureSuggestions(db, today, { asOf: now.toISOString() });
    }
  } catch (error) {
    console.error(`progression: not prepared (${error instanceof Error ? error.name : "error"})`);
  }
}

/** Deletes a group (entries cascade) and its bot session_items row if unused. */
async function deleteGroup(q: Q, groupId: number): Promise<GroupSnapshot | null> {
  const snap = await groupSnapshot(q, groupId);
  if (!snap) return null;
  const before =
    snap.plannedItemId === null
      ? undefined
      : await recordedItemBefore(q, groupId, snap.plannedItemId);
  await q.delete(logGroups).where(eq(logGroups.id, groupId));
  await cleanupSessionItem(q, snap.sessionDate, snap.plannedItemId, before);
  return snap;
}

export async function executeActions(
  db: Db,
  sourceKey: string,
  actions: StagedAction[],
  opts: {
    pendingId?: number;
    now?: Date;
    replaceActions?: StagedAction[];
    replaceReasons?: string[];
    /** Where the request came from; stored on the log group. */
    source?: InputSource;
  } = {},
): Promise<ExecuteResult> {
  const now = opts.now ?? new Date();
  await prepareProgression(db, now, actions);
  try {
    const result = await runActions(db, sourceKey, actions, opts, now);
    // A chat readiness note before the first log of the day moves today's level (SPEC 5.6c).
    if (result.status === "done" && result.results.some((r) => r.kind === "readiness")) {
      try {
        await refreezeIfFrozen(db, trainingDate(now), now);
      } catch (error) {
        console.error(
          `readiness: re-freeze failed (${error instanceof Error ? error.name : "error"})`,
        );
      }
    }
    return result;
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
  opts: {
    pendingId?: number;
    replaceActions?: StagedAction[];
    replaceReasons?: string[];
    source?: InputSource;
  },
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
      if (claimed.length > 0 && opts.replaceActions) {
        // Same transaction as the claim and the writes: a failure leaves the pending untouched,
        // and a pending that can't be claimed (expired, replaced) is never modified.
        await tx
          .update(pendingActions)
          .set({
            actions: opts.replaceActions,
            awaitingEdit: false,
            ...(opts.replaceReasons ? { reasons: opts.replaceReasons } : {}),
          })
          .where(eq(pendingActions.id, opts.pendingId));
      }
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
    let touchedHistory = false;
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
      const result = await writeAction(tx, action, now, opts.source);
      await tx
        .update(writeLedger)
        .set({ result })
        .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, i)));
      results.push(result);
      if (
        action.kind === "log_sets" ||
        action.kind === "edit_group" ||
        action.kind === "delete_group" ||
        action.kind === "set_band_kg"
      ) {
        touchedHistory = true;
      }
    }
    // Pull-up gate and HSPU step are rebuilt from history after every write (SPEC 5.2).
    if (touchedHistory) await refreshUserState(tx);
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

/** Remembers the Telegram message of a direct write's echo (only for a `log` result). */
export async function recordEchoMessage(
  db: Q,
  sourceKey: string,
  actionIndex: number,
  messageId: number,
): Promise<void> {
  await db
    .update(writeLedger)
    .set({ result: sql`${writeLedger.result} || ${JSON.stringify({ messageId })}::jsonb` })
    .where(
      and(
        eq(writeLedger.sourceKey, sourceKey),
        eq(writeLedger.actionIndex, actionIndex),
        sql`${writeLedger.result}->>'kind' = 'log'`,
      ),
    );
}

/** The echo message recorded for a group's write, if any (old rows and card writes have none). */
export async function findEchoMessage(db: Q, groupId: number): Promise<number | null> {
  const [row] = await db
    .select({ result: writeLedger.result })
    .from(writeLedger)
    .where(
      and(
        sql`${writeLedger.result}->>'kind' = 'log'`,
        sql`(${writeLedger.result}->>'groupId')::int = ${groupId}`,
        sql`${writeLedger.result} ? 'messageId'`,
      ),
    )
    .orderBy(desc(writeLedger.createdAt))
    .limit(1);
  const r = row?.result;
  return r?.kind === "log" && typeof r.messageId === "number" ? r.messageId : null;
}

/** Removes a group. Returns its snapshot, or null when it was already gone. */
export async function undoGroup(db: Db, groupId: number): Promise<GroupSnapshot | null> {
  return db.transaction(async (tx) => {
    const snap = await deleteGroup(tx, groupId);
    if (snap) await refreshUserState(tx);
    return snap;
  });
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
        await cleanupSessionItem(tx, g.sessionDate, g.plannedItemId, result.sessionItemBefore);
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
    await refreshUserState(tx);
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
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ id: logEntries.id })
      .from(logEntries)
      .where(eq(logEntries.groupId, groupId))
      .orderBy(desc(logEntries.setIndex))
      .limit(1);
    if (!last) return null;
    await tx.update(logEntries).set({ rir, rirPlus: plus }).where(eq(logEntries.id, last.id));
    // The e1RM (and so the implied-reps gate rule) depends on the logged RIR.
    await refreshUserState(tx);
    return groupSnapshot(tx, groupId);
  });
}

export type UndoWriteResult =
  | { status: "undone"; text: string }
  /** The value changed after the write, so restoring would overwrite newer data. */
  | { status: "stale" }
  | { status: "none" };

/**
 * Undo for the direct writes that are not log groups: readiness note, bodyweight, Thursday class. Restores the previous
 * value (or removes the row) and re-freezes the day's readiness while no log exists yet. Safe to repeat.
 */
export async function undoWrite(
  db: Db,
  sourceKey: string,
  actionIndex: number,
  now: Date,
): Promise<UndoWriteResult> {
  const [row] = await db
    .select({ result: writeLedger.result })
    .from(writeLedger)
    .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, actionIndex)));
  const r = row?.result;
  if (!r) return { status: "none" };
  if (r.kind === "readiness") {
    const gone = await db
      .delete(readinessLogs)
      .where(eq(readinessLogs.id, r.id))
      .returning({ id: readinessLogs.id });
    if (gone.length === 0) return { status: "none" };
    try {
      await refreezeIfFrozen(db, trainingDate(now), now);
    } catch (error) {
      console.error(
        `readiness: re-freeze failed (${error instanceof Error ? error.name : "error"})`,
      );
    }
    return { status: "undone", text: "Readiness note removed." };
  }
  if (r.kind === "bodyweight") {
    const [cur] = await db.select().from(bodyweightLogs).where(eq(bodyweightLogs.id, r.id));
    if (!cur) return { status: "none" };
    if (cur.kg !== r.kg) return { status: "stale" };
    if (r.previousKg === null) {
      await db.delete(bodyweightLogs).where(eq(bodyweightLogs.id, r.id));
      return { status: "undone", text: "Bodyweight removed." };
    }
    await db.update(bodyweightLogs).set({ kg: r.previousKg }).where(eq(bodyweightLogs.id, r.id));
    return { status: "undone", text: `Bodyweight back to ${r.previousKg} kg.` };
  }
  if (r.kind === "class") {
    const [cur] = await db.select().from(classLogs).where(eq(classLogs.id, r.id));
    if (!cur) return { status: "none" };
    if ([...cur.heavyGroups].sort().join() !== [...r.heavyGroups].sort().join()) {
      return { status: "stale" };
    }
    // A newer write changed moves, photo or text: restoring would overwrite it.
    if (
      r.written &&
      (JSON.stringify(cur.parsed ?? null) !== JSON.stringify(r.written.parsed ?? null) ||
        cur.photoFileId !== r.written.photoFileId ||
        cur.rawText !== r.written.rawText)
    ) {
      return { status: "stale" };
    }
    if (r.previousRow === undefined) {
      // Ledger row from before previousRow: only the heavy groups were tracked.
      if (r.previousGroups === null) {
        await db.delete(classLogs).where(eq(classLogs.id, r.id));
        return { status: "undone", text: "Class report removed." };
      }
      await db
        .update(classLogs)
        .set({ heavyGroups: r.previousGroups })
        .where(eq(classLogs.id, r.id));
      return { status: "undone", text: "Class report restored." };
    }
    if (r.previousRow === null) {
      await db.delete(classLogs).where(eq(classLogs.id, r.id));
      return { status: "undone", text: "Class report removed." };
    }
    await db
      .update(classLogs)
      .set({
        heavyGroups: r.previousRow.heavyGroups,
        parsed: r.previousRow.parsed,
        photoFileId: r.previousRow.photoFileId,
        rawText: r.previousRow.rawText,
      })
      .where(eq(classLogs.id, r.id));
    return { status: "undone", text: "Class report restored." };
  }
  return { status: "none" };
}

/** The clean buttons: applies to every set of the group. */
export async function setGroupClean(
  db: Db,
  groupId: number,
  clean: boolean,
): Promise<GroupSnapshot | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(logEntries)
      .set({ clean })
      .where(eq(logEntries.groupId, groupId))
      .returning({ id: logEntries.id });
    if (rows.length === 0) return null;
    // "Clean" opens or closes the pull-up gate (SPEC 5.2).
    await refreshUserState(tx);
    return groupSnapshot(tx, groupId);
  });
}
