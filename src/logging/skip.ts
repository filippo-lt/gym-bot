/**
 * Skipping planned items (SPEC 5.7 /skip, 5.6d). An item is "open" for a date when it has no log
 * group and no session_items row beyond 'planned'. A skip only flips session_items.status, so an
 * imported row keeps its source and Undo can put it back exactly.
 */
import { and, eq } from "drizzle-orm";
import { baseItemName } from "../bot/format.js";
import { writeLedger } from "../db/schema/agent.js";
import { logGroups, sessionItems } from "../db/schema/log.js";
import { trainingDate } from "../domain/calendar.js";
import { loadCatalog } from "./catalog.js";
import type { Db, Q, Tx } from "./db.js";
import { dateLabel } from "./describe.js";
import { type DayItem, loadDayPlan, loadPlanContext, weekRefFor } from "./plan-context.js";
import { dateForDay, fuzzyScore, pickExercise, SLUG_FIT_FLOOR } from "./resolve.js";
import type {
  LedgerResult,
  SessionItemBefore,
  SkipItemsInput,
  SkipTarget,
  StagedAction,
  StageResult,
} from "./types.js";

type SkipAction = Extract<StagedAction, { kind: "skip_items" }>;
type SkipResult = Extract<LedgerResult, { kind: "skip" }>;

const isOpen = (i: DayItem): boolean => !i.hasGroup && i.status === "planned";

const toTarget = (i: DayItem): SkipTarget => ({
  plannedItemId: i.info.id,
  planName: i.info.planName,
  label: baseItemName(
    { options: i.options, planName: i.info.planName, variantLabel: i.variantLabel },
    i.hspuStepName,
  ),
  priority: i.info.priority,
});

/** The planned items of a date: whether the day has a session at all, and which are still open. */
export async function loadSkipDay(
  db: Q,
  date: string,
): Promise<{ hasSession: boolean; open: SkipTarget[]; items: DayItem[] }> {
  const ctx = await loadPlanContext(db, date);
  const plan = await loadDayPlan(db, ctx, date);
  return {
    hasSession: plan.items.length > 0,
    open: plan.items.filter(isOpen).map(toTarget),
    items: plan.items,
  };
}

export function skipAction(
  date: string,
  whole: boolean,
  items: SkipTarget[],
  flags: { otherDay?: boolean; ambiguous?: boolean } = {},
): SkipAction {
  return {
    kind: "skip_items",
    sessionDate: date,
    whole,
    items,
    ...(flags.otherDay ? { otherDay: true } : {}),
    ...(flags.ambiguous ? { ambiguous: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Write

const nameFields = (t: SkipTarget) => ({
  planName: t.planName,
  ...(t.label ? { label: t.label } : {}),
});

/** Skips the targets that are still open inside the executor's transaction. */
export async function writeSkip(tx: Tx, a: SkipAction): Promise<SkipResult> {
  const items: SkipResult["items"] = [];
  for (const t of a.items) {
    const key = and(
      eq(sessionItems.sessionDate, a.sessionDate),
      eq(sessionItems.plannedItemId, t.plannedItemId),
    );
    const [group] = await tx
      .select({ id: logGroups.id })
      .from(logGroups)
      .where(
        and(eq(logGroups.sessionDate, a.sessionDate), eq(logGroups.plannedItemId, t.plannedItemId)),
      )
      .limit(1);
    if (group) continue;
    const [row] = await tx
      .select({
        status: sessionItems.status,
        chosenExerciseId: sessionItems.chosenExerciseId,
        source: sessionItems.source,
      })
      .from(sessionItems)
      .where(key);
    if (row) {
      if (row.status !== "planned") continue;
      const updated = await tx
        .update(sessionItems)
        .set({ status: "skipped" })
        .where(and(key, eq(sessionItems.status, "planned")))
        .returning({ id: sessionItems.id });
      // A concurrent writer may have changed the row since the check above.
      if (updated.length === 0) continue;
      items.push({ plannedItemId: t.plannedItemId, ...nameFields(t), before: row });
      continue;
    }
    const inserted = await tx
      .insert(sessionItems)
      .values({
        sessionDate: a.sessionDate,
        plannedItemId: t.plannedItemId,
        status: "skipped",
        chosenExerciseId: null,
        source: "bot",
      })
      .onConflictDoNothing()
      .returning({ id: sessionItems.id });
    if (inserted.length > 0) {
      items.push({ plannedItemId: t.plannedItemId, ...nameFields(t), before: null });
    }
  }
  return { kind: "skip", sessionDate: a.sessionDate, whole: a.whole, items };
}

export type UndoSkipResult = { status: "undone"; names: string[] } | { status: "none" };

/**
 * Puts each skipped item back as it was, but only while it is still 'skipped': an item logged
 * since is 'done' and stays. Safe to repeat.
 */
export async function undoSkip(
  db: Db,
  sourceKey: string,
  actionIndex: number,
): Promise<UndoSkipResult> {
  // Accepted risk: an old Undo button can undo a newer skip of the same item.
  return db.transaction(async (tx): Promise<UndoSkipResult> => {
    const [row] = await tx
      .select({ result: writeLedger.result })
      .from(writeLedger)
      .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, actionIndex)));
    const result = row?.result;
    if (result?.kind !== "skip") return { status: "none" };
    const names: string[] = [];
    for (const item of result.items) {
      const key = and(
        eq(sessionItems.sessionDate, result.sessionDate),
        eq(sessionItems.plannedItemId, item.plannedItemId),
        eq(sessionItems.status, "skipped"),
      );
      const restored = await restoreSkipped(tx, key, item.before);
      if (restored) names.push(item.label ?? item.planName);
    }
    return names.length > 0 ? { status: "undone", names } : { status: "none" };
  });
}

async function restoreSkipped(
  tx: Tx,
  key: ReturnType<typeof and>,
  before: SessionItemBefore | null,
): Promise<boolean> {
  const rows = before
    ? await tx
        .update(sessionItems)
        .set({ status: before.status, chosenExerciseId: before.chosenExerciseId })
        .where(key)
        .returning({ id: sessionItems.id })
    : await tx
        .delete(sessionItems)
        .where(and(key, eq(sessionItems.source, "bot")))
        .returning({ id: sessionItems.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Staging (the skip_items tool)

const fail = (error: string): StageResult => ({ ok: false, error });
const names = (xs: SkipTarget[]) => xs.map((x) => x.planName).join(", ");

/**
 * The words matched no catalog exercise exactly: the day's items that fit them best, by plan name
 * or option name. Several items qualify only when they offer the same exercises.
 */
function bestFuzzyItems(said: string, items: DayItem[]): DayItem[] {
  const scored = items.map((i) => ({
    i,
    score: Math.max(
      fuzzyScore(said, { slug: "", name: i.info.planName }),
      ...i.options.map((o) => fuzzyScore(said, o)),
    ),
  }));
  const top = Math.max(0, ...scored.map((x) => x.score));
  if (top < SLUG_FIT_FLOOR) return [];
  const best = scored.filter((x) => x.score === top).map((x) => x.i);
  const slugs = (i: DayItem) => i.options.map((o) => o.slug).join("|");
  return best.every((i) => slugs(i) === slugs(best[0] as DayItem)) ? best : [];
}

export async function stageSkip(db: Q, input: SkipItemsInput, now: Date): Promise<StageResult> {
  const today = trainingDate(now);
  const ctx = await loadPlanContext(db, today);
  if (input.day && input.day !== "today" && (!ctx || !weekRefFor(ctx, today))) {
    return fail(`No plan week for ${input.day}.`);
  }
  const date = dateForDay(ctx, today, input.day);
  const label = dateLabel(date);
  const { open, items } = await loadSkipDay(db, date);

  if (input.whole_session) {
    if (open.length === 0) return fail(`Nothing open to skip on ${label}.`);
    return {
      ok: true,
      action: skipAction(date, true, open, { otherDay: date !== today }),
      preview: `Staged skip of the whole session (${names(open)}) for ${label}. The bot will save or confirm it. Do not repeat it.`,
    };
  }

  const ex = input.exercise as NonNullable<SkipItemsInput["exercise"]>;
  const noMatch = () =>
    fail(
      `No open item matches "${ex.said}" on ${label}. Open items: ${open.length ? names(open) : "none"}. Ask the user which one.`,
    );
  const catalog = await loadCatalog(db);
  const day = { date, weekday: null, week: null, phase: null, items };
  const picked = await pickExercise(db, ex, catalog, day);
  const matches =
    picked.kind === "ok"
      ? items.filter((i) => i.options.some((o) => o.slug === picked.exercise.slug))
      : bestFuzzyItems(ex.said, items);
  if (matches.length === 0) return noMatch();
  const openMatches = matches.filter(isOpen);
  const narrowed = openMatches.length > 1 ? bestFuzzyItems(ex.said, openMatches) : openMatches;
  const candidates = narrowed.length > 0 ? narrowed : openMatches;
  const target = candidates[0];
  if (!target) {
    const logged = matches.some((i) => i.hasGroup || i.status !== "skipped");
    const first = matches[0] as DayItem;
    return fail(`${first.info.planName} is already ${logged ? "logged" : "skipped"} on ${label}.`);
  }
  return {
    ok: true,
    action: skipAction(date, false, [toTarget(target)], {
      otherDay: date !== today,
      ambiguous: candidates.length > 1,
    }),
    preview: `Staged skip of ${target.info.planName} for ${label}. The bot will save or confirm it. Do not repeat it.`,
  };
}
