/** Confirmation policy (SPEC 5.6d). Pure: code decides, never the model. */

import type { ConfirmReason, PolicyDecision, StagedAction } from "./types.js";
import { maxReps, maxSystemLoad } from "./units.js";

export const FAR_OFF_LOAD_RATIO = 0.2;
export const FAR_OFF_MIN_STEPS = 2;
export const FAR_OFF_REPS_FACTOR = 2;

/** > 20 % from the reference AND at least 2 equipment steps away (20 % alone when step unknown). */
export function isLoadFarOff(
  newLoad: number | null,
  refLoad: number | null,
  stepKg: number | null,
): boolean {
  if (newLoad === null || refLoad === null || refLoad <= 0) return false;
  const diff = Math.abs(newLoad - refLoad);
  if (diff / refLoad <= FAR_OFF_LOAD_RATIO) return false;
  return stepKg === null || diff >= FAR_OFF_MIN_STEPS * stepKg;
}

/** New best reps at least twice the reference (often a voice transcription error). */
export function isRepsFarOff(newReps: number | null, refReps: number | null): boolean {
  if (newReps === null || refReps === null || refReps <= 0) return false;
  return newReps >= FAR_OFF_REPS_FACTOR * refReps;
}

/** The load (kg) that made the action "far from last time", or null when it did not. */
export function farOffLoad(a: StagedAction): number | null {
  if (a.kind === "log_sets") {
    const r = a.resolved;
    const load = maxSystemLoad(r.entries, r.exercise, r.bwKg);
    const ref = r.lastSession?.maxSystemLoad ?? null;
    return isLoadFarOff(load, ref, r.exercise.equipment?.stepKg ?? null) ? load : null;
  }
  if (a.kind === "edit_group") {
    const changed = a.after.entries.filter((e) => a.setIndexes.includes(e.setIndex));
    const load = maxSystemLoad(changed, a.after.exercise, a.after.bwKg);
    const ref = a.lastSession?.maxSystemLoad ?? null;
    return isLoadFarOff(load, ref, a.after.exercise.equipment?.stepKg ?? null) ? load : null;
  }
  return null;
}

/** The best reps that made the action "look high", or null when they did not. */
export function farOffReps(a: StagedAction): number | null {
  if (a.kind === "log_sets") {
    const r = a.resolved;
    const reps = maxReps(r.entries);
    const ref = r.lastSession?.bestReps ?? r.plannedItem?.repsMax ?? null;
    return isRepsFarOff(reps, ref) ? reps : null;
  }
  if (a.kind === "edit_group") {
    const changed = a.after.entries.filter((e) => a.setIndexes.includes(e.setIndex));
    const reps = maxReps(changed);
    return isRepsFarOff(reps, a.lastSession?.bestReps ?? null) ? reps : null;
  }
  return null;
}

function actionReasons(a: StagedAction): ConfirmReason[] {
  const out: ConfirmReason[] = [];
  switch (a.kind) {
    case "log_sets": {
      const r = a.resolved;
      if (r.match === "unplanned") out.push("not_in_today");
      if (r.match === "makeup") out.push("makeup");
      if (r.missingFields.length > 0) out.push("missing_field");
      if (r.guessedFields.length > 0) out.push("guessed");
      if (r.needsConfirmation) out.push("model_flag");
      break;
    }
    case "edit_group":
      if (a.input.guessed_fields.length > 0) out.push("guessed");
      if (a.input.needs_confirmation) out.push("model_flag");
      break;
    case "delete_group":
      out.push("delete");
      break;
    case "clarify_exercise":
      break;
  }
  if (farOffLoad(a) !== null) out.push("load_far_off");
  if (farOffReps(a) !== null) out.push("reps_far_off");
  return out;
}

export function decidePolicy(actions: StagedAction[]): PolicyDecision {
  const clarify = actions.findIndex((a) => a.kind === "clarify_exercise");
  if (clarify >= 0) return { mode: "clarify", index: clarify };
  const reasons: ConfirmReason[] = [];
  if (actions.length > 1) reasons.push("multiple_writes");
  for (const a of actions) {
    for (const r of actionReasons(a)) if (!reasons.includes(r)) reasons.push(r);
  }
  return reasons.length === 0 ? { mode: "direct" } : { mode: "confirm", reasons };
}
