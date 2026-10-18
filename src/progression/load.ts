import { roundTowardEasier } from "./rounding.js";
import type { ExerciseInfo, ItemTarget, Suggestion } from "./types.js";

/**
 * Load for reps_min at the middle of the RIR target (SPEC 5.2): load = e1rm / (1 + (repsMin + rirMid) / 30),
 * rounded toward easier. bodyweight_plus: subtract bwKg -> added or assistance; null bw -> `ask: "bodyweight"`.
 * `opts.gateOpen` (pull-up gate, default false): when open and the needed load is below bodyweight, the suggestion is
 * plain bodyweight (no assistance), plan default 1. Labels are left empty for the engine to fill.
 */
export function suggestMainLoad(
  e1rm: number,
  target: ItemTarget,
  ex: ExerciseInfo,
  bwKg: number | null,
  rirMid: number,
  opts: { gateOpen?: boolean } = {},
): Suggestion {
  const repsMin = target.repsMin ?? target.repsMax ?? 1;
  const base: Suggestion = {
    sets: target.setsMin ?? target.setsMax ?? 1,
    repsMin,
    repsMax: target.repsMax ?? repsMin,
    rirMin: target.rirMin ?? rirMid,
    rirMax: target.rirMax ?? rirMid,
    e1rmUsed: e1rm,
    labels: [],
  };
  const needed = e1rm / (1 + (repsMin + rirMid) / 30);

  if (ex.loadBasis !== "bodyweight_plus" && ex.type !== "bodyweight_plus") {
    const r = roundTowardEasier({ loadKg: needed }, ex);
    return { ...base, loadKg: r.loadKg, systemLoad: r.loadKg };
  }

  if (bwKg == null) return { ...base, ask: "bodyweight" };
  const diff = needed - bwKg;
  if (diff >= 0 || opts.gateOpen) {
    const r = roundTowardEasier({ addedKg: Math.max(0, diff) }, ex);
    const added = r.addedKg ?? 0;
    return { ...base, addedKg: added, systemLoad: bwKg + added };
  }
  const r = roundTowardEasier({ assistKg: -diff }, ex);
  if (r.ask) return { ...base, ask: r.ask };
  const assist = r.assistKg ?? 0;
  return { ...base, assistKg: assist, band: r.band, systemLoad: bwKg - assist };
}
