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

export interface FarOffRef {
  load: number;
  ref: number;
  /** What the load was compared to: the stored suggestion first, else the last logged session (SPEC 5.6d). */
  source: "suggested" | "last";
}

/** The reference load: the stored suggestion's system load, else the last session's; null = no check. */
function loadReference(
  suggested: number | null | undefined,
  last: number | null | undefined,
): { ref: number; source: FarOffRef["source"] } | null {
  if (suggested != null) return { ref: suggested, source: "suggested" };
  if (last != null) return { ref: last, source: "last" };
  return null;
}

/** The load (kg) that made the action far off and the reference it was compared to. */
export function farOffLoadRef(a: StagedAction): FarOffRef | null {
  if (a.kind === "log_sets") {
    const r = a.resolved;
    const load = maxSystemLoad(r.entries, r.exercise, r.bwKg);
    const ref = loadReference(r.suggestedSystemLoad, r.lastSession?.maxSystemLoad);
    return load !== null &&
      ref !== null &&
      isLoadFarOff(load, ref.ref, r.exercise.equipment?.stepKg ?? null)
      ? { load, ...ref }
      : null;
  }
  if (a.kind === "edit_group") {
    const changed = a.after.entries.filter((e) => a.setIndexes.includes(e.setIndex));
    const load = maxSystemLoad(changed, a.after.exercise, a.after.bwKg);
    const ref = loadReference(a.suggestedSystemLoad, a.lastSession?.maxSystemLoad);
    return load !== null &&
      ref !== null &&
      isLoadFarOff(load, ref.ref, a.after.exercise.equipment?.stepKg ?? null)
      ? { load, ...ref }
      : null;
  }
  return null;
}

/** The load (kg) that made the action "far from last time", or null when it did not. */
export function farOffLoad(a: StagedAction): number | null {
  return farOffLoadRef(a)?.load ?? null;
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
    const ref = a.lastSession?.bestReps ?? a.plannedRepsMax ?? null;
    return isRepsFarOff(reps, ref) ? reps : null;
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
    case "save_memory":
      out.push("memory");
      break;
    case "set_band_kg":
      out.push("equipment");
      break;
    case "skip_items":
      if (a.otherDay) out.push("not_in_today");
      if (a.whole) out.push("skip_session");
      if (a.items.some((i) => i.priority === "PRIMARY")) out.push("skip_primary");
      if (a.ambiguous) out.push("skip_ambiguous");
      break;
    case "clarify_exercise":
    case "log_readiness":
    case "log_bodyweight":
      break;
    case "log_class":
      if (a.input.moves) out.push("class_moves");
      break;
  }
  if (farOffLoad(a) !== null) out.push("load_far_off");
  if (farOffReps(a) !== null) out.push("reps_far_off");
  return out;
}

export interface PolicyContext {
  /** The chat already has an unsaved request (a card, with or without ✏️). */
  openPending?: boolean;
  /** A tool call errored during this intent, so part of the message was not understood. */
  partlyUnderstood?: boolean;
  /** The message came from a voice note (always a card, never a direct write). */
  voiceInput?: boolean;
}

export function decidePolicy(actions: StagedAction[], ctx: PolicyContext = {}): PolicyDecision {
  const clarify = actions.findIndex((a) => a.kind === "clarify_exercise");
  if (clarify >= 0) return { mode: "clarify", index: clarify };
  const reasons: ConfirmReason[] = [];
  if (ctx.openPending) reasons.push("replaces_pending");
  if (ctx.partlyUnderstood) reasons.push("partly_understood");
  if (ctx.voiceInput && actions.length > 0) reasons.push("voice_input");
  if (actions.length > 1) reasons.push("multiple_writes");
  for (const a of actions) {
    for (const r of actionReasons(a)) if (!reasons.includes(r)) reasons.push(r);
  }
  return reasons.length === 0 ? { mode: "direct" } : { mode: "confirm", reasons };
}
