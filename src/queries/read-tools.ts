/**
 * The facts behind Claude's read tools (M4). Every value is read or formatted in code; the
 * model only phrases an answer from them. Each result also carries the code-formatted answer
 * the bot falls back on when the model's reply fails the number guard.
 */
import { and, eq } from "drizzle-orm";
import { extraLine, fallbackLine, formatSession, weekRange } from "../bot/format.js";
import { formatHistory, historyLines } from "../bot/query-format.js";
import { getSession } from "../bot/session.js";
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

export async function readSession(db: Db, now: Date, input: GetSessionInput): Promise<ReadResult> {
  const today = trainingDate(now);
  const ref = parseDayArg(input.date ?? input.day ?? "today", today);
  if (!ref.ok) return refused(ref.error);
  const date = ref.date;
  const s = await getSession(db, date);
  const fallbackHtml = formatSession(s);
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
  const next = nextItem(s);
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
          fallback: i.fallback ? fallbackLine(i.fallback) : null,
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
      suggestion: "not available yet",
    },
    fallbackHtml: formatHistory(history),
  };
}

export async function readAlternatives(db: Db, input: GetAlternativesInput): Promise<ReadResult> {
  const found = await lookupExercise(db, input.exercise.said, input.exercise.slug);
  if (found.kind !== "ok") return notFound(found);
  const facts = await getAlternativeFacts(db, { id: found.exercise.id });
  if (!facts) return notFound({ kind: "unknown" });
  return { facts: { found: true, want: input.want ?? null, ...facts }, fallbackHtml: null };
}
