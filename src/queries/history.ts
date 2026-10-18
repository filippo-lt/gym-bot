/** Read-only: the last sessions of one exercise, any source. */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { logEntries, logGroups } from "../db/schema/log.js";
import { equipment, exercises, hspuLadder, planWeeks } from "../db/schema/plan.js";
import { planWeekFor } from "../domain/calendar.js";
import { type DayName, dayName } from "../domain/day-ref.js";
import type { Db } from "../logging/db.js";
import { loadPlanContext } from "../logging/plan-context.js";
import { bandAssist } from "../logging/units.js";
import type { ExerciseType, LoadBasis } from "../plan-import/types.js";

export const DEFAULT_HISTORY_LIMIT = 5;
export const MAX_HISTORY_LIMIT = 10;

export interface HistorySet {
  /** 1-based position across the session (groups of one day are merged in order). */
  setIndex: number;
  reps: number | null;
  loadKg: number | null;
  addedKg: number | null;
  assistKg: number | null;
  durationS: number | null;
  distanceM: number | null;
  padHeight: number | null;
  rir: number | null;
  /** RIR was "4+" (rir = 4). */
  rirPlus: boolean;
  clean: boolean | null;
  /** Band colour (pull-up assistance), when used. */
  band?: string | null;
}

export interface HistorySession {
  sessionDate: string;
  weekday: DayName;
  /** Plan week of the date; null outside the plan. */
  week: number | null;
  phase: string | null;
  isDeload: boolean;
  isTest: boolean;
  /** "import" only when every group of the day came from the history import. */
  source: "bot" | "import";
  /**
   * The old tool only knew the total reps, not the split: such a group is one set whose
   * `reps` is the total.
   */
  perSetUnknown: boolean;
  /** HSPU ladder step name (latest group of the day that has one). */
  hspuStep: string | null;
  sets: HistorySet[];
}

export interface ExerciseHistory {
  exercise: {
    id: number;
    slug: string;
    name: string;
    type: ExerciseType;
    loadBasis: LoadBasis | null;
  };
  /** Distinct training days with this exercise inside since/until, not only the ones returned. */
  totalSessions: number;
  /** Newest first. */
  sessions: HistorySession[];
}

export interface HistoryOptions {
  limit?: number;
  /** Inclusive ISO dates on session_date. */
  since?: string;
  until?: string;
}

/** Sequential queries on purpose: the session pooler hangs on pipelined queries. */
export async function getExerciseHistory(
  db: Db,
  exerciseId: number,
  opts: HistoryOptions = {},
): Promise<ExerciseHistory | null> {
  const limit = Math.min(
    Math.max(Math.trunc(opts.limit ?? DEFAULT_HISTORY_LIMIT), 1),
    MAX_HISTORY_LIMIT,
  );

  const [ex] = await db
    .select({
      id: exercises.id,
      slug: exercises.slug,
      name: exercises.name,
      type: exercises.type,
      loadBasis: exercises.loadBasis,
    })
    .from(exercises)
    .where(eq(exercises.id, exerciseId));
  if (!ex) return null;

  const conds = [eq(logGroups.exerciseId, exerciseId)];
  if (opts.since) conds.push(gte(logGroups.sessionDate, opts.since));
  if (opts.until) conds.push(lte(logGroups.sessionDate, opts.until));
  const dateRows = await db
    .select({
      date: logGroups.sessionDate,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(logGroups)
    .where(and(...conds))
    .groupBy(logGroups.sessionDate)
    .orderBy(desc(logGroups.sessionDate))
    .limit(limit);
  const dates = dateRows.map((r) => r.date);
  const result: ExerciseHistory = {
    exercise: ex,
    totalSessions: dateRows[0]?.total ?? 0,
    sessions: [],
  };
  if (dates.length === 0) return result;

  // A band decides the assistance through the equipment's colour map, as the engine reads it.
  const [eqRow] = await db
    .select({ bands: equipment.bands })
    .from(exercises)
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
    .where(eq(exercises.id, exerciseId));
  const bands = eqRow?.bands ?? {};

  const rows = await db
    .select({ g: logGroups, e: logEntries, step: hspuLadder.name })
    .from(logGroups)
    .innerJoin(logEntries, eq(logEntries.groupId, logGroups.id))
    .leftJoin(hspuLadder, eq(hspuLadder.id, logGroups.hspuStepId))
    .where(and(eq(logGroups.exerciseId, exerciseId), inArray(logGroups.sessionDate, dates)))
    .orderBy(asc(logGroups.performedAt), asc(logGroups.id), asc(logEntries.setIndex));

  // Plan weeks of the version that applies to the newest day (the week table is tiny).
  const ctx = await loadPlanContext(db, dates[0] as string);
  const weekRows = ctx
    ? await db.select().from(planWeeks).where(eq(planWeeks.planVersionId, ctx.versionId))
    : [];
  const weekInfo = new Map(weekRows.map((w) => [w.week, w]));

  const byDate = new Map<string, HistorySession>();
  for (const date of dates) {
    const status = ctx
      ? planWeekFor(date, ctx.startDate, ctx.weeks)
      : { status: "finished" as const };
    const week = status.status === "active" ? status.week : null;
    const info = week === null ? undefined : weekInfo.get(week);
    byDate.set(date, {
      sessionDate: date,
      weekday: dayName(date),
      week,
      phase: info?.phase ?? null,
      isDeload: info?.isDeload ?? false,
      isTest: info?.isTest ?? false,
      source: "import",
      perSetUnknown: false,
      hspuStep: null,
      sets: [],
    });
  }
  for (const { g, e, step } of rows) {
    const s = byDate.get(g.sessionDate) as HistorySession;
    if (g.source !== "import") s.source = "bot";
    if (g.perSetUnknown) s.perSetUnknown = true;
    if (step) s.hspuStep = step;
    s.sets.push({
      setIndex: s.sets.length + 1,
      reps: e.reps,
      loadKg: e.loadKg,
      addedKg: e.addedKg,
      assistKg: bandAssist(e.band, e.assistKg, bands),
      durationS: e.durationS,
      distanceM: e.distanceM,
      padHeight: e.padHeight,
      rir: e.rir,
      rirPlus: e.rirPlus,
      clean: e.clean,
      band: e.band,
    });
  }
  result.sessions = dates.map((d) => byDate.get(d) as HistorySession);
  return result;
}
