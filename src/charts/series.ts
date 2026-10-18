/**
 * Pure chart series (M8). History in, plain points out: no DB, no clock, no rendering.
 * Validity rules are the engine's (`sessionEstimate` / `validSets`), never re-implemented here.
 */
import { sessionEstimate } from "../progression/e1rm.js";
import type { ExerciseInfo, ExerciseType, SessionRec } from "../progression/types.js";

/** `flagged` = deload or test week (shaded, never an e1RM point); `estimate` = import-only session. */
export interface LoadPoint {
  date: string;
  week: number | null;
  e1rm: number | null;
  flagged: boolean;
  estimate: boolean;
}

export interface RepsPoint {
  date: string;
  week: number | null;
  bestSet: number | null;
  seconds: number | null;
  step: string | null;
  flagged: boolean;
  /** Import-only session (`source === "import"`): drawn hollow. */
  estimate: boolean;
}

export type ChartKind = "load" | "load_reps" | "reps" | "hspu" | "timed" | "none";

/**
 * `distance` is "none": the engine's `SetRec` carries no distance, so there is no metric to plot without
 * re-reading the log tables outside the shared types.
 */
export function chartKindFor(type: ExerciseType): ChartKind {
  switch (type) {
    case "weighted":
      return "load";
    case "bodyweight_plus":
      return "load_reps";
    case "bodyweight_reps":
      return "reps";
    case "skill_ladder":
      return "hspu";
    case "timed":
      return "timed";
    default:
      return "none";
  }
}

function oldestFirst(sessions: SessionRec[]): SessionRec[] {
  return [...sessions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** One e1RM per session: max(strict, withPlus), same "4+ may raise, never lower" rule as `currentE1rm`. */
export function loadSeries(sessions: SessionRec[], ex: ExerciseInfo): LoadPoint[] {
  return oldestFirst(sessions).map((s) => {
    const { strict, withPlus } = sessionEstimate(s, ex);
    const values = [strict, withPlus].filter((v): v is number => v != null);
    return {
      date: s.date,
      week: s.week,
      e1rm: values.length > 0 ? Math.max(...values) : null,
      flagged: s.isDeload || s.isTest,
      estimate: s.source === "import",
    };
  });
}

/** Most reps in one logged set (any logged set, RIR not required); longest hold for `timed`. perSetUnknown sessions (total only) and unclean sets are skipped; empty sessions dropped. */
export function repsSeries(
  sessions: SessionRec[],
  ex: ExerciseInfo,
  stepNames?: Map<number, string>,
): RepsPoint[] {
  const out: RepsPoint[] = [];
  for (const s of oldestFirst(sessions)) {
    if (s.perSetUnknown) continue;
    let bestSet: number | null = null;
    let seconds: number | null = null;
    for (const set of s.sets) {
      if (set.clean === false) continue;
      if (ex.type === "timed") {
        if (set.durationS != null && (seconds == null || set.durationS > seconds)) {
          seconds = set.durationS;
        }
      } else if (set.reps != null && (bestSet == null || set.reps > bestSet)) {
        bestSet = set.reps;
      }
    }
    if (bestSet == null && seconds == null) continue;
    out.push({
      date: s.date,
      week: s.week,
      bestSet,
      seconds,
      step: s.hspuStepOrder != null ? (stepNames?.get(s.hspuStepOrder) ?? null) : null,
      flagged: s.isDeload || s.isTest,
      estimate: s.source === "import",
    });
  }
  return out;
}

export interface VolumeCell {
  week: number;
  muscleGroup: string;
  sets: number;
}

/** Types that count as hard sets (SPEC 5.2); `timed`, mobility, HIIT and practice do not. */
export const VOLUME_TYPES: readonly ExerciseType[] = [
  "weighted",
  "bodyweight_plus",
  "bodyweight_reps",
  "skill_ladder",
];

/**
 * Sets per (plan week, muscle group), weeks 1..currentWeek. Empty weeks produce no cell; rows outside the plan
 * (week null) or after `currentWeek` are dropped. Sorted by week, then muscle group.
 */
export function volumeSeries(
  rows: { week: number | null; muscleGroup: string; type: ExerciseType; sets: number }[],
  currentWeek: number,
): VolumeCell[] {
  const sums = new Map<string, VolumeCell>();
  for (const r of rows) {
    if (r.week == null || r.week < 1 || r.week > currentWeek) continue;
    if (!VOLUME_TYPES.includes(r.type)) continue;
    const key = `${r.week}|${r.muscleGroup}`;
    const cell = sums.get(key);
    if (cell) cell.sets += r.sets;
    else sums.set(key, { week: r.week, muscleGroup: r.muscleGroup, sets: r.sets });
  }
  return [...sums.values()].sort(
    (a, b) =>
      a.week - b.week ||
      (a.muscleGroup < b.muscleGroup ? -1 : a.muscleGroup > b.muscleGroup ? 1 : 0),
  );
}
