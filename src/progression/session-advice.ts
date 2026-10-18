/**
 * What the bot shows for a session date (M5): the engine's adjusted session for today, or the stored suggestions for a
 * past date. Every read is sequential (session pooler). Nothing here is shown to the model without going through the
 * code formatters.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { logGroups, weeklyMetrics } from "../db/schema/log.js";
import { readinessLogs, suggestions } from "../db/schema/progression.js";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { planDayOn } from "../plan/effective.js";
import type { HiitSpec } from "../plan-import/types.js";
import { hspuState } from "./hspu.js";
import { loadExerciseInfos, loadFrozenLevel, RECOVERY_METRIC } from "./load-history.js";
import { earlierDeloadHint } from "./readiness.js";
import { applyShort } from "./short.js";
import { ensureSuggestions, freezeReadiness, suggestionFromRow } from "./store.js";
import type {
  AdjustedItem,
  ExerciseInfo,
  FridayAdjustment,
  HspuAdvanceProposal,
  HspuLadderStep,
  HspuReps,
  PullupPlan,
  ReadinessLevel,
  SessionRec,
  Suggestion,
} from "./types.js";

export interface AdviceItem {
  plannedItemId: number;
  /** Per option exerciseId. */
  suggestions: Record<number, Suggestion | null>;
  hidden: boolean;
  optional: boolean;
  skipOffer: boolean;
  friday: FridayAdjustment | null;
  /** Sets x reps x RIR actually prescribed; null in stored mode. */
  prescription: AdjustedItem["prescription"] | null;
  /** HIIT after halving; undefined = not computed (stored mode). */
  hiit: HiitSpec | null | undefined;
  pullup: PullupPlan | null;
  hspu: HspuReps | null;
  /** The user's current ladder step for an HSPU item (name + pad height). */
  hspuStep: { order: number; name: string; padHeight: number | null } | null;
  hspuAdvance: {
    from: { order: number; name: string };
    to: { order: number; name: string };
  } | null;
}

export interface SessionAdvice {
  /** live = computed for today; stored = what was saved for a past date. */
  mode: "live" | "stored";
  date: string;
  level: ReadinessLevel | null;
  /** Kinds of the signals behind the level ("chat_bad_sleep", ...). */
  levelKinds: string[];
  restDaySuggested: boolean;
  askClassFirst: boolean;
  needsBodyweight: boolean;
  bodyweightDate: string | null;
  classAdvice: boolean;
  isTest: boolean;
  /** Text line only: RED twice in a row or low recovery two weeks (SPEC 5.6c). */
  earlierDeloadHint: boolean;
  items: Map<number, AdviceItem>;
  exercises: Record<number, ExerciseInfo>;
}

function adviceItem(
  item: AdjustedItem,
  input: { history: Record<number, SessionRec[]>; hspuLadder: HspuLadderStep[] },
  flags: { hidden?: boolean; optional?: boolean } | undefined,
): AdviceItem {
  const ladder = input.hspuLadder;
  const stepOf = (order: number) => ladder.find((l) => l.stepOrder === order);
  let hspuStep: AdviceItem["hspuStep"] = null;
  if (item.hspu) {
    for (const exId of item.target.exerciseIds) {
      const state = hspuState(input.history[exId] ?? []);
      const step = state.stepOrder === null ? undefined : stepOf(state.stepOrder);
      if (step) {
        hspuStep = { order: step.stepOrder, name: step.name, padHeight: state.padHeight };
        break;
      }
    }
  }
  let hspuAdvance: AdviceItem["hspuAdvance"] = null;
  const adv: HspuAdvanceProposal | null = item.hspuAdvance;
  if (adv) {
    const from = stepOf(adv.fromStepOrder);
    const to = stepOf(adv.toStepOrder);
    if (from && to) {
      hspuAdvance = {
        from: { order: from.stepOrder, name: from.name },
        to: { order: to.stepOrder, name: to.name },
      };
    }
  }
  return {
    plannedItemId: item.target.plannedItemId,
    suggestions: item.suggestions,
    hidden: item.hidden || flags?.hidden === true,
    optional: item.optional || flags?.optional === true,
    skipOffer: item.skipOffer,
    friday: item.friday,
    prescription: item.prescription,
    hiit: item.hiit,
    pullup: item.pullup,
    hspu: item.hspu,
    hspuStep,
    hspuAdvance,
  };
}

function parseKinds(note: string | null | undefined): string[] {
  if (!note) return [];
  try {
    const v: unknown = JSON.parse(note);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

async function derivedRow(db: Db, date: string) {
  const [row] = await db
    .select()
    .from(readinessLogs)
    .where(and(eq(readinessLogs.date, date), eq(readinessLogs.source, "derived")))
    .orderBy(desc(readinessLogs.id))
    .limit(1);
  return row ?? null;
}

/** Text-only "move the deload earlier" hint: today's level plus the last session's, and the last two recovery scores. */
async function deloadHint(db: Db, date: string, todayLevel: ReadinessLevel): Promise<boolean> {
  const [prev] = await db
    .selectDistinct({ d: logGroups.sessionDate })
    .from(logGroups)
    .where(lt(logGroups.sessionDate, date))
    .orderBy(desc(logGroups.sessionDate))
    .limit(1);
  const levels: ReadinessLevel[] = [];
  if (prev) levels.push((await loadFrozenLevel(db, prev.d)) ?? "GREEN");
  levels.push(todayLevel);
  const rec = await db
    .select({ week: weeklyMetrics.planWeek, value: weeklyMetrics.valueNum })
    .from(weeklyMetrics)
    .where(eq(weeklyMetrics.metric, RECOVERY_METRIC))
    .orderBy(desc(weeklyMetrics.planWeek))
    .limit(2);
  const scores = rec.map((r) => r.value).reverse();
  return earlierDeloadHint(levels, scores);
}

export interface AdviceOptions {
  /** /short: hide Low items, flag Medium (SPEC 5.2). */
  short?: boolean;
}

/**
 * Today: freeze the readiness level (from 05:00 Rome, SPEC 5.6c), store the suggestions and return the adjusted
 * session. A past date shows what was stored, never freezing or computing anything. A future date has no advice.
 */
export async function loadSessionAdvice(
  db: Db,
  date: string,
  now: Date,
  opts: AdviceOptions = {},
): Promise<SessionAdvice | null> {
  const today = trainingDate(now);
  if (date > today) return null;
  return date === today ? liveAdvice(db, date, now, opts) : storedAdvice(db, date);
}

async function liveAdvice(
  db: Db,
  date: string,
  now: Date,
  opts: AdviceOptions,
): Promise<SessionAdvice | null> {
  const frozen = await freezeReadiness(db, date, now, { trigger: "today" });
  const res = await ensureSuggestions(db, date, { asOf: now.toISOString() });
  if (!res) return null;
  const session = res.session;
  const flags = opts.short ? applyShort(res.input.items) : new Map();
  const items = new Map<number, AdviceItem>();
  for (const item of session.items) {
    items.set(
      item.target.plannedItemId,
      adviceItem(item, res.input, flags.get(item.target.plannedItemId)),
    );
  }
  const row = frozen.frozen ? await derivedRow(db, date) : null;
  const kinds = row ? parseKinds(row.note) : frozen.counted.map((c) => c.kind);
  return {
    mode: "live",
    date,
    level: session.level,
    levelKinds: kinds,
    restDaySuggested: session.restDaySuggested,
    askClassFirst: session.askClassFirst,
    needsBodyweight: session.needsBodyweight,
    bodyweightDate: session.bodyweightDate ?? null,
    classAdvice: session.classAdvice === true,
    isTest: session.isTest,
    earlierDeloadHint: await deloadHint(db, date, session.level),
    items,
    exercises: res.input.exercises,
  };
}

async function storedAdvice(db: Db, date: string): Promise<SessionAdvice | null> {
  const all = await db.select().from(suggestions).where(eq(suggestions.sessionDate, date));
  // Only the exercise shown on that date counts: a one-off swap leaves the replaced exercise's row behind.
  const day = await planDayOn(db, date);
  const shown = new Map<number, Set<number>>();
  if (day.kind === "day") {
    for (const it of day.items) shown.set(it.plannedItemId, new Set(it.options.map((o) => o.id)));
  }
  const rows = all.filter((r) => {
    const opts = shown.get(r.plannedItemId);
    return !opts || opts.has(r.exerciseId);
  });
  const row = await derivedRow(db, date);
  if (rows.length === 0 && !row) return null;
  const exerciseIds = [...new Set(rows.map((r) => r.exerciseId))];
  const exercises = await loadExerciseInfos(db, exerciseIds);
  const items = new Map<number, AdviceItem>();
  for (const r of rows) {
    let item = items.get(r.plannedItemId);
    if (!item) {
      item = {
        plannedItemId: r.plannedItemId,
        suggestions: {},
        hidden: false,
        optional: false,
        skipOffer: false,
        friday: null,
        prescription: null,
        hiit: undefined,
        pullup: null,
        hspu: null,
        hspuStep: null,
        hspuAdvance: null,
      };
      items.set(r.plannedItemId, item);
    }
    item.suggestions[r.exerciseId] = suggestionFromRow(r);
  }
  return {
    mode: "stored",
    date,
    level: (row?.level as ReadinessLevel | null | undefined) ?? null,
    levelKinds: parseKinds(row?.note),
    restDaySuggested: false,
    askClassFirst: false,
    needsBodyweight: false,
    bodyweightDate: null,
    classAdvice: false,
    isTest: false,
    earlierDeloadHint: false,
    items,
    exercises,
  };
}
