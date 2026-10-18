/**
 * DB -> chart input (M8). Reads history only (log_groups / log_entries), never planned_items.
 * Reads are sequential on purpose: the session pooler hangs on pipelined queries.
 */
import { count, eq, gte } from "drizzle-orm";
import { logEntries, logGroups } from "../db/schema/log.js";
import { exercises, hspuLadder } from "../db/schema/plan.js";
import type { Db } from "../logging/db.js";
import {
  loadExerciseInfos,
  loadPlanEnv,
  loadSessionRecs,
  weekFor,
} from "../progression/load-history.js";
import type { ExerciseInfo, SessionRec } from "../progression/types.js";
import type { volumeSeries } from "./series.js";

export interface ExerciseHistoryData {
  ex: ExerciseInfo;
  name: string;
  /** Oldest first. */
  sessions: SessionRec[];
  /** HSPU ladder `step_order` -> step name. */
  stepNames: Map<number, string>;
}

export async function loadExerciseChartData(
  db: Db,
  exerciseId: number,
  sinceDate?: string,
): Promise<ExerciseHistoryData | null> {
  const ex = (await loadExerciseInfos(db, [exerciseId]))[exerciseId];
  if (!ex) return null;
  const [row] = await db
    .select({ name: exercises.name })
    .from(exercises)
    .where(eq(exercises.id, exerciseId));
  const env = await loadPlanEnv(db);
  const recs = env
    ? await loadSessionRecs(db, env, { [exerciseId]: ex }, [exerciseId], null)
    : null;
  const newestFirst = recs?.get(exerciseId) ?? [];
  const sessions = newestFirst.filter((s) => !sinceDate || s.date >= sinceDate).reverse();
  const steps = await db
    .select({ stepOrder: hspuLadder.stepOrder, name: hspuLadder.name })
    .from(hspuLadder);
  return {
    ex,
    name: row?.name ?? ex.slug,
    sessions,
    stepNames: new Map(steps.map((s) => [s.stepOrder, s.name])),
  };
}

/**
 * One row per log group: its plan week, the exercise's muscle group and type, and its set count (= `log_entries`
 * rows). `log_groups` has no stated set count, so an imported group without entry rows counts 0.
 */
export async function loadVolumeRows(
  db: Db,
  sinceDate?: string,
): Promise<Parameters<typeof volumeSeries>[0]> {
  const env = await loadPlanEnv(db);
  const base = db
    .select({
      date: logGroups.sessionDate,
      muscleGroup: exercises.muscleGroup,
      type: exercises.type,
      sets: count(logEntries.id),
    })
    .from(logGroups)
    .innerJoin(exercises, eq(exercises.id, logGroups.exerciseId))
    .leftJoin(logEntries, eq(logEntries.groupId, logGroups.id));
  const rows = await (sinceDate ? base.where(gte(logGroups.sessionDate, sinceDate)) : base).groupBy(
    logGroups.id,
    logGroups.sessionDate,
    exercises.muscleGroup,
    exercises.type,
  );
  return rows.map((r) => ({
    week: env ? (weekFor(env, r.date)?.week ?? null) : null,
    muscleGroup: r.muscleGroup,
    type: r.type,
    sets: r.sets,
  }));
}
