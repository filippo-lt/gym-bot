/**
 * The facts behind Claude's read tools (M4). Every value is read or formatted in code; the
 * model only phrases an answer from them. Each result also carries the code-formatted answer
 * the bot falls back on when the model's reply fails the number guard.
 */
import { and, eq } from "drizzle-orm";
import {
  advisedPrescription,
  exerciseBySlug,
  extraLine,
  fallbackLine,
  formatSession,
  fridayText,
  HEAVY_TAGS,
  weekRange,
} from "../bot/format.js";
import {
  askText,
  range as fmtRange,
  heavyGroupFor,
  levelLines,
  loadText,
  suggestionNotes,
} from "../bot/progression-format.js";
import { formatHistory, historyLines } from "../bot/query-format.js";
import { getSession, type SessionItem } from "../bot/session.js";
import { planWeeks } from "../db/schema/plan.js";
import { trainingDate } from "../domain/calendar.js";
import { dayName, parseDayArg } from "../domain/day-ref.js";
import type { Db } from "../logging/db.js";
import { dateLabel } from "../logging/describe.js";
import { addDays, loadPlanContext } from "../logging/plan-context.js";
import {
  type GetAlternativesInput,
  type GetExerciseHistoryInput,
  type GetSessionInput,
  HISTORY_DEFAULT_LAST_N,
  type ReadResult,
} from "../logging/types.js";
import { currentE1rm } from "../progression/e1rm.js";
import { loadExerciseInfos, loadPlanEnv, loadSessionRecs } from "../progression/load-history.js";
import {
  type AdviceItem,
  loadSessionAdvice,
  type SessionAdvice,
} from "../progression/session-advice.js";
import { getAlternativeFacts } from "./alternatives.js";
import { lookupExercise } from "./exercise-lookup.js";
import { getExerciseHistory } from "./history.js";
import { nextItem } from "./plan-overview.js";

const range = (min: number | null, max: number | null): string | null =>
  min === null ? null : max === null || max === min ? String(min) : `${min}-${max}`;

const refused = (error: string): ReadResult => ({
  facts: { error },
  fallbackHtml: null,
  isError: true,
});

/** Monday of the ISO week of `date`. */
function mondayOf(date: string): string {
  const index = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(dayName(date));
  return addDays(date, -index);
}

/** The engine failing must not take the plan away from a read: the facts then carry no suggestions. */
async function adviceOrNull(db: Db, date: string, now: Date): Promise<SessionAdvice | null> {
  try {
    return await loadSessionAdvice(db, date, now);
  } catch (error) {
    console.error(`progression: advice failed (${error instanceof Error ? error.name : "error"})`);
    return null;
  }
}

/** Suggested loads of one item, formatted in code (never by the model). */
function suggestionFacts(
  item: SessionItem,
  adv: AdviceItem | undefined,
  advice: SessionAdvice,
  heavy: ("pull" | "push" | "legs")[],
) {
  if (!adv) return { suggestions: [], adjusted_prescription: null, friday: null, hidden: false };
  const ctx = { bodyweightDate: advice.bodyweightDate };
  const suggestions = item.options.map((o) => {
    const ex = exerciseBySlug(advice, o.slug);
    const s = ex ? (adv.suggestions[ex.id] ?? null) : null;
    return {
      exercise: o.slug,
      load: ex && s ? loadText(ex, s) : null,
      sets_reps: s ? `${s.sets} x ${fmtRange(s.repsMin, s.repsMax)}` : null,
      rir: s ? fmtRange(s.rirMin, s.rirMax) : null,
      labels: suggestionNotes(s, ctx),
      ask: s ? askText(s, ctx) : null,
    };
  });
  const group = heavyGroupFor(item.tags, heavy, HEAVY_TAGS);
  return {
    suggestions,
    adjusted_prescription: advisedPrescription(item, adv),
    friday: fridayText(adv, group ? `heavy ${group} Thursday` : "heavy Thursday"),
    hidden: adv.hidden,
  };
}

export async function readSession(db: Db, now: Date, input: GetSessionInput): Promise<ReadResult> {
  const today = trainingDate(now);
  const ref = parseDayArg(input.date ?? input.day ?? "today", today);
  if (!ref.ok) return refused(ref.error);
  const date = ref.date;
  const s = await getSession(db, date);
  const advice = s.kind === "session" ? await adviceOrNull(db, date, now) : null;
  const fallbackHtml = formatSession(s, advice);
  const base = { requestedDate: date, label: dateLabel(date), isToday: date === today };
  if (s.kind === "before_start") {
    return { facts: { ...base, kind: "before_start", startDate: s.startDate }, fallbackHtml };
  }
  if (s.kind === "finished") return { facts: { ...base, kind: "plan_finished" }, fallbackHtml };
  const monday = mondayOf(date);
  const week = { start: monday, end: addDays(monday, 6), label: weekRange(monday) };
  if (s.kind === "rest") {
    return {
      facts: {
        ...base,
        kind: "rest_day",
        date: s.date,
        week: s.week,
        phase: s.phase,
        weekRange: week,
      },
      fallbackHtml,
    };
  }
  const next = nextItem(
    s,
    new Set([...(advice?.items ?? [])].filter(([, a]) => a.hidden).map(([id]) => id)),
  );
  const heavy = s.thursday && s.thursday !== "not_reported" ? s.thursday.heavy : [];
  return {
    facts: {
      ...base,
      kind: "session",
      date: s.date,
      weekday: s.weekday,
      week: s.week,
      phase: s.phase,
      focus: s.focus,
      deload: s.isDeload,
      weekRange: week,
      readiness: advice
        ? {
            level: advice.level,
            what_it_means: levelLines(advice.level, advice.levelKinds, {
              restDay: advice.restDaySuggested,
              classAdvice: advice.classAdvice,
            }),
            ask_thursday_class_first: advice.askClassFirst,
            stored_for_a_past_day: advice.mode === "stored",
          }
        : null,
      suggestions_note: advice
        ? "Loads in each item's suggestions are code-computed estimates: quote them as given."
        : date > today
          ? "No suggested loads for a future day."
          : "No suggested loads for this day.",
      items: s.items
        .filter((i) => i.subItem === 0)
        .map((i) => ({
          name: i.planName,
          options: i.options.map((o) => o.slug),
          sets: range(i.setsMin, i.setsMax),
          reps: range(i.repsMin, i.repsMax),
          prescription: i.prescriptionRaw,
          rir: range(i.rirMin, i.rirMax),
          status: i.status,
          fallback:
            i.fallback && !advice?.items.get(i.plannedItemId)?.pullup
              ? fallbackLine(i.fallback)
              : null,
          ...(advice ? suggestionFacts(i, advice.items.get(i.plannedItemId), advice, heavy) : {}),
          extras: s.items
            .filter((e) => e.subItem > 0 && e.itemOrder === i.itemOrder)
            .map((e) => extraLine(e)),
        })),
      next:
        next.kind === "item"
          ? { kind: "item", name: next.item.planName, position: next.position, total: next.total }
          : { kind: next.kind },
    },
    fallbackHtml,
  };
}

interface Window {
  since?: string;
  until?: string;
  label: string;
}

async function historyWindow(
  db: Db,
  today: string,
  input: GetExerciseHistoryInput,
): Promise<Window | { error: string }> {
  if (input.period) {
    const monday = mondayOf(today);
    const start = input.period === "this_week" ? monday : addDays(monday, -7);
    const name = input.period === "this_week" ? "this week" : "last week";
    return { since: start, until: addDays(start, 6), label: `${name} (${weekRange(start)})` };
  }
  if (input.plan_week !== undefined) {
    const ctx = await loadPlanContext(db, today);
    const [row] = ctx
      ? await db
          .select({ startDate: planWeeks.startDate })
          .from(planWeeks)
          .where(
            and(eq(planWeeks.planVersionId, ctx.versionId), eq(planWeeks.week, input.plan_week)),
          )
      : [];
    if (!row) return { error: `The plan has no week ${input.plan_week}.` };
    return {
      since: row.startDate,
      until: addDays(row.startDate, 6),
      label: `plan week ${input.plan_week} (${weekRange(row.startDate)})`,
    };
  }
  return { label: "all time" };
}

const notFound = (
  lookup: { kind: "ambiguous"; candidates: { slug: string; name: string }[] } | { kind: "unknown" },
): ReadResult => ({
  facts:
    lookup.kind === "ambiguous"
      ? {
          found: false,
          reason: "ambiguous",
          candidates: lookup.candidates.map((c) => ({ slug: c.slug, name: c.name })),
        }
      : { found: false, reason: "unknown", candidates: [] },
  fallbackHtml: null,
});

export async function readExerciseHistory(
  db: Db,
  now: Date,
  input: GetExerciseHistoryInput,
): Promise<ReadResult> {
  const found = await lookupExercise(db, input.exercise.said, input.exercise.slug);
  if (found.kind !== "ok") return notFound(found);
  const window = await historyWindow(db, trainingDate(now), input);
  if ("error" in window) return refused(window.error);
  const history = await getExerciseHistory(db, found.exercise.id, {
    limit: input.last_n ?? HISTORY_DEFAULT_LAST_N,
    since: window.since,
    until: window.until,
  });
  if (!history) return notFound({ kind: "unknown" });
  const lines = historyLines(history);
  return {
    facts: {
      found: true,
      exercise: { slug: history.exercise.slug, name: history.exercise.name },
      range_label: window.label,
      total_sessions: history.totalSessions,
      sessions: history.sessions.map((s, i) => ({
        date: s.sessionDate,
        weekday: s.weekday,
        plan_week: s.week,
        deload: s.isDeload,
        source: s.source,
        sets: s.sets,
        line: lines[i],
      })),
      current_e1rm: await e1rmFact(db, found.exercise.id),
    },
    fallbackHtml: formatHistory(history),
  };
}

/** Current e1RM of an exercise, formatted in code; null when there is none yet (SPEC 5.2). */
async function e1rmFact(db: Db, exerciseId: number) {
  try {
    const env = await loadPlanEnv(db);
    if (!env) return null;
    const infos = await loadExerciseInfos(db, [exerciseId]);
    const info = infos[exerciseId];
    if (!info) return null;
    const recs = await loadSessionRecs(db, env, infos, [exerciseId], null);
    const e = currentE1rm(recs.get(exerciseId) ?? [], info);
    if (!e) return null;
    return {
      value: `${Math.round(e.value * 10) / 10} kg`,
      label: e.basis === "single" || e.importedOnly ? "estimate" : null,
    };
  } catch (error) {
    console.error(`progression: e1rm failed (${error instanceof Error ? error.name : "error"})`);
    return null;
  }
}

export async function readAlternatives(db: Db, input: GetAlternativesInput): Promise<ReadResult> {
  const found = await lookupExercise(db, input.exercise.said, input.exercise.slug);
  if (found.kind !== "ok") return notFound(found);
  const facts = await getAlternativeFacts(db, { id: found.exercise.id });
  if (!facts) return notFound({ kind: "unknown" });
  return { facts: { found: true, want: input.want ?? null, ...facts }, fallbackHtml: null };
}
