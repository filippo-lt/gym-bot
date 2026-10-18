/**
 * One checker for the keys an exercise can take, shared by log_sets and edits.
 * A key the exercise can't use is a tool error that names the field, never a silent drop.
 */

import type { ResolvedExercise } from "./types.js";
import { convertLoad } from "./units.js";

export interface UsedKeys {
  load_kg?: unknown;
  plates_per_side_kg?: unknown;
  pair_total_kg?: unknown;
  added_kg?: unknown;
  assist_kg?: unknown;
  band?: unknown;
  duration_s?: unknown;
  distance_m?: unknown;
  pad_height?: unknown;
  hspu_step?: unknown;
  clean?: unknown;
}

const NO_LOAD_TYPES = new Set<ResolvedExercise["type"]>([
  "bodyweight_reps",
  "skill_ladder",
  "skill_practice",
  "hiit",
  "mobility",
  "warmup",
  "class",
  "recovery",
]);

/** Union of the keys present on any of the given objects (sets, or edit changes). */
export function usedKeys(...objects: UsedKeys[]): UsedKeys {
  const out: Record<string, unknown> = {};
  for (const o of objects) {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      // clean keeps its value: only `true` is something a non-clean exercise can't take
      out[k] = k === "clean" ? v === true || out[k] === true : true;
    }
  }
  return out;
}

export function checkKeys(
  exercise: Pick<ResolvedExercise, "name" | "type" | "loadBasis" | "equipment" | "needsClean">,
  used: UsedKeys,
  opts: { checkClean?: boolean } = {},
): string | null {
  const has = (k: keyof UsedKeys) => used[k] !== undefined;
  const n = exercise.name;
  const t = exercise.type;
  if (has("hspu_step") && t !== "skill_ladder") {
    return `hspu_step only applies to HSPU; ${n} is not an HSPU exercise.`;
  }
  if (has("pad_height") && t !== "skill_ladder") {
    return `pad_height only applies to HSPU; ${n} is not an HSPU exercise.`;
  }
  if (has("band") && t !== "bodyweight_plus") {
    return `band only applies to pull-up type exercises; ${n} does not use a band.`;
  }
  if (t === "bodyweight_plus") {
    if (has("plates_per_side_kg") || has("pair_total_kg")) {
      return `${has("plates_per_side_kg") ? "plates_per_side_kg" : "pair_total_kg"} does not apply to ${n}. Use added_kg or assist_kg.`;
    }
  } else if (NO_LOAD_TYPES.has(t)) {
    const k = (
      ["load_kg", "plates_per_side_kg", "pair_total_kg", "added_kg", "assist_kg"] as const
    ).find(has);
    if (k) return `${k} does not apply to ${n}: it has no load.`;
  } else {
    if (has("added_kg") || has("assist_kg")) {
      return `${has("added_kg") ? "added_kg" : "assist_kg"} does not apply to ${n}. Use load_kg.`;
    }
    if (has("plates_per_side_kg") && exercise.loadBasis !== "barbell_total") {
      return `plates_per_side_kg only applies to barbell exercises; ${n} does not use a barbell. Use load_kg.`;
    }
    if (has("pair_total_kg") && exercise.loadBasis !== "per_hand") {
      return `pair_total_kg only applies to dumbbell exercises; ${n} does not use dumbbells. Use load_kg.`;
    }
    if (
      has("plates_per_side_kg") &&
      !has("load_kg") &&
      convertLoad(exercise, { plates_per_side_kg: 0 }) === null
    ) {
      return `The bar weight for ${n} is unknown, so plates_per_side_kg cannot be used. Use load_kg.`;
    }
  }
  if ((t === "weighted" || t === "bodyweight_plus") && (has("duration_s") || has("distance_m"))) {
    return `${has("duration_s") ? "duration_s" : "distance_m"} does not apply to ${n}.`;
  }
  if (opts.checkClean && used.clean === true && !exercise.needsClean) {
    return `clean does not apply to ${n}.`;
  }
  return null;
}

/** Two ways to say the same load in one set or change: ask for one, never drop one silently. */
export function checkConflicts(
  exercise: Pick<ResolvedExercise, "type">,
  used: UsedKeys,
): string | null {
  const has = (k: keyof UsedKeys) => used[k] !== undefined;
  const clash = (a: keyof UsedKeys, b: keyof UsedKeys) =>
    `${a} and ${b} conflict: send only one of them.`;
  if (has("load_kg") && has("plates_per_side_kg")) return clash("load_kg", "plates_per_side_kg");
  if (has("load_kg") && has("pair_total_kg")) return clash("load_kg", "pair_total_kg");
  if (has("plates_per_side_kg") && has("pair_total_kg")) {
    return clash("plates_per_side_kg", "pair_total_kg");
  }
  if (exercise.type === "bodyweight_plus" && has("added_kg") && has("load_kg")) {
    return clash("added_kg", "load_kg");
  }
  return null;
}
