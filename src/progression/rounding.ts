import type { ExerciseInfo } from "./types.js";

const EPS = 1e-9;

function clean(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function floorToStep(value: number, step: number): number {
  return clean(Math.floor(value / step + EPS) * step);
}

function isBodyweightPlus(ex: ExerciseInfo): boolean {
  return ex.loadBasis === "bodyweight_plus" || ex.type === "bodyweight_plus";
}

/**
 * Round an external load toward easier (lower) on the exercise's grid:
 * discrete values (racks/stacks) -> greatest value <= load (lowest value if below all);
 * otherwise base + k * step (barbell: never below the bar) or k * step. Negative loads floor too (more assistance).
 * No usable equipment -> the load floored to 0.01.
 */
export function roundLoadDown(load: number, ex: ExerciseInfo): number {
  const eq = ex.equipment;
  const discrete = eq?.discreteValues;
  if (discrete && discrete.length > 0) {
    const sorted = [...discrete].sort((a, b) => a - b);
    let pick = sorted[0] as number;
    for (const v of sorted) if (v <= load + EPS) pick = v;
    return pick;
  }
  const step = eq?.stepKg;
  if (!eq || !step || step <= 0) return Math.floor(load * 100 + EPS) / 100;
  if (ex.loadBasis === "barbell_total") {
    const base = eq.baseKg ?? 0;
    if (load <= base) return base;
    return clean(base + floorToStep(load - base, step));
  }
  return floorToStep(load, step);
}

/**
 * Move `load` by `delta` grid steps (+1 / -1 / 0). The load is first snapped down to the grid.
 * Barbell never goes below the bar; discrete values clamp at both ends; other grids clamp at 0.
 */
export function stepLoad(load: number, delta: number, ex: ExerciseInfo): number {
  const eq = ex.equipment;
  const snapped = roundLoadDown(load, ex);
  if (delta === 0) return snapped;
  const discrete = eq?.discreteValues;
  if (discrete && discrete.length > 0) {
    const sorted = [...discrete].sort((a, b) => a - b);
    const i = sorted.indexOf(snapped);
    const j = Math.min(sorted.length - 1, Math.max(0, i + delta));
    return sorted[j] as number;
  }
  const step = eq?.stepKg;
  if (!eq || !step || step <= 0) return snapped;
  const floor = ex.loadBasis === "barbell_total" ? (eq.baseKg ?? 0) : 0;
  return clean(Math.max(floor, snapped + delta * step));
}

/**
 * Round a target toward easier per equipment (SPEC 5.2): barbell = base + k*step (floor), dumbbells/stack = discrete
 * values (floor), bodyweight_plus added = floor to step, assistance = smallest band >= needed (ceil) else `ask: "band"`.
 * A negative addedKg is read as assistance.
 */
export function roundTowardEasier(
  target: { loadKg?: number; addedKg?: number; assistKg?: number },
  ex: ExerciseInfo,
): { loadKg?: number; addedKg?: number; assistKg?: number; band?: string; ask?: "band" } {
  const out: { loadKg?: number; addedKg?: number; assistKg?: number; band?: string; ask?: "band" } =
    {};
  if (!isBodyweightPlus(ex)) {
    if (target.loadKg !== undefined) out.loadKg = roundLoadDown(target.loadKg, ex);
    return out;
  }

  let added = target.addedKg;
  let assist = target.assistKg;
  if (added !== undefined && added < 0) {
    assist = (assist ?? 0) - added;
    added = 0;
  }
  if (added !== undefined) {
    const step = ex.equipment?.stepKg;
    out.addedKg =
      step && step > 0 ? floorToStep(Math.max(0, added), step) : clean(Math.max(0, added));
  }
  if (assist !== undefined) {
    if (assist <= EPS) {
      out.assistKg = 0;
    } else {
      const bands = Object.entries(ex.equipment?.bands ?? {}).sort((a, b) => a[1] - b[1]);
      const hit = bands.find(([, kg]) => kg + EPS >= assist);
      if (hit) {
        out.assistKg = hit[1];
        out.band = hit[0];
      } else {
        out.ask = "band";
      }
    }
  }
  return out;
}
