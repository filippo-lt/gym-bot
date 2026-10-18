import { stepLoad } from "./rounding.js";
import type { ExerciseInfo, ItemTarget, SessionRec } from "./types.js";

function lastRir(s: SessionRec): number | null {
  return s.sets.length > 0 ? (s.sets[s.sets.length - 1]?.rir ?? null) : null;
}

/**
 * Accessory rule (SPEC 5.2). lastValid: newest first, deload/test already excluded by caller (also filtered here).
 * +1 if all sets hit reps_max and last-set RIR >= rir_min; -1 if any set < reps_min or last-set RIR 0 in 2 sessions in a row; else 0.
 */
export function accessoryStep(lastValid: SessionRec[], target: ItemTarget): 1 | -1 | 0 {
  const sessions = lastValid.filter(
    (s) => !s.isDeload && !s.isTest && !s.perSetUnknown && s.sets.length > 0,
  );
  const latest = sessions[0];
  if (!latest) return 0;

  const { repsMin, repsMax } = target;
  if (repsMin != null && latest.sets.some((s) => s.reps != null && s.reps < repsMin)) return -1;
  const prev = sessions[1];
  if (prev && lastRir(latest) === 0 && lastRir(prev) === 0) return -1;

  const rir = lastRir(latest);
  if (
    repsMax != null &&
    rir != null &&
    rir >= (target.rirMin ?? 0) &&
    latest.sets.every((s) => s.reps != null && s.reps >= repsMax)
  ) {
    return 1;
  }
  return 0;
}

/** Move `lastLoad` by `step` equipment steps (rounded toward easier on decrease; stays on the grid). */
export function applyStep(lastLoad: number, step: 1 | -1 | 0, ex: ExerciseInfo): number {
  return stepLoad(lastLoad, step, ex);
}
