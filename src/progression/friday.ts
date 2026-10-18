import type { FridayAdjustment, HeavyGroup, ItemTarget } from "./types.js";

/** Tags a heavy Thursday group touches (same mapping as src/bot/format.ts HEAVY_TAGS). */
const REDUCE_TAG: Record<HeavyGroup, "row" | "horizontal_press" | "squat"> = {
  pull: "row",
  push: "horizontal_press",
  legs: "squat",
};

/**
 * Friday auto-regulation by tags (SPEC 5.2): pull -> `row`, push -> `horizontal_press`, legs -> `squat` (reduce) and
 * `unilateral_leg` (offer skip; skipped on a deload Friday). Keyed by plannedItemId. Items not hit are absent.
 *
 * Deload Friday + heavy group: matching items drop to 1 easy set (skippable); the unilateral leg item is skipped.
 * The caller only invokes this on a Friday. When Thursday was not reported (`classReported` false) the engine must ask
 * first and pass `heavy = []` meanwhile (this function then returns an empty map).
 */
export function fridayAdjust(
  items: ItemTarget[],
  heavy: HeavyGroup[],
  isDeload: boolean,
): Map<number, FridayAdjustment> {
  const out = new Map<number, FridayAdjustment>();
  if (heavy.length === 0) return out;
  const reduceTags = new Set<string>(heavy.map((g) => REDUCE_TAG[g]));
  const legs = heavy.includes("legs");
  for (const item of items) {
    const tags = item.tags;
    if (tags.some((t) => reduceTags.has(t))) {
      const reps = item.repsMin ?? item.repsMax;
      if (isDeload)
        out.set(item.plannedItemId, { kind: "deload_reduce", sets: 1, skippable: true });
      else if (reps === null) out.set(item.plannedItemId, { kind: "offer_skip" });
      else
        out.set(item.plannedItemId, {
          kind: "reduce",
          sets: 2,
          reps,
          rirMin: 3,
          rirMax: 4,
          skippable: true,
        });
    } else if (legs && tags.includes("unilateral_leg")) {
      out.set(item.plannedItemId, isDeload ? { kind: "skip" } : { kind: "offer_skip" });
    }
  }
  return out;
}
