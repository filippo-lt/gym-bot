import { describe, expect, it } from "vitest";
import { fridayAdjust } from "../../src/progression/friday.js";
import type { FridayAdjustment, HeavyGroup } from "../../src/progression/types.js";
import { byName, HEAVY_COMBOS, targetsFor } from "./helpers-session.js";

const label = (h: HeavyGroup[]) => (h.length ? h.join("+") : "none");

describe("fridayAdjust", () => {
  for (const deload of [false, true]) {
    const items = targetsFor(deload ? 4 : 1, "fri");
    const squat = byName(items, "Squat / hack");
    const press = byName(items, "Incline DB");
    const row = byName(items, "Cable / machine row");
    const bulg = byName(items, "Bulgarian");
    const others = items.filter((i) => ![squat, press, row, bulg].includes(i));

    for (const heavy of HEAVY_COMBOS) {
      it(`${deload ? "deload" : "normal"} Friday, heavy ${label(heavy)}`, () => {
        const out = fridayAdjust(items, heavy, deload);
        const expected = new Map<number, FridayAdjustment>();
        const hit = (tgt: typeof squat, reps: number) =>
          expected.set(
            tgt.plannedItemId,
            deload
              ? { kind: "deload_reduce", sets: 1, skippable: true }
              : { kind: "reduce", sets: 2, reps, rirMin: 3, rirMax: 4, skippable: true },
          );
        if (heavy.includes("pull")) hit(row, row.repsMin as number);
        if (heavy.includes("push")) hit(press, press.repsMin as number);
        if (heavy.includes("legs")) {
          hit(squat, squat.repsMin as number);
          expected.set(bulg.plannedItemId, deload ? { kind: "skip" } : { kind: "offer_skip" });
        }
        expect(out).toEqual(expected);
        for (const o of others) expect(out.has(o.plannedItemId)).toBe(false);
      });
    }
  }

  it("reduces to reps_min of the plan (squat 6 in week 1, 5 in week 4 is deload-only)", () => {
    const items = targetsFor(1, "fri");
    const adj = fridayAdjust(items, ["legs"], false).get(
      byName(items, "Squat / hack").plannedItemId,
    );
    expect(adj).toMatchObject({ kind: "reduce", reps: 6, sets: 2 });
  });

  it("not heavy / not reported (empty heavy) changes nothing, even on a deload", () => {
    expect(fridayAdjust(targetsFor(4, "fri"), [], true).size).toBe(0);
  });

  it("an item without reps gets an offer_skip instead of a made-up reduction", () => {
    const items = targetsFor(1, "fri");
    const row = { ...byName(items, "Cable / machine row"), repsMin: null, repsMax: null };
    expect(fridayAdjust([row], ["pull"], false).get(row.plannedItemId)).toEqual({
      kind: "offer_skip",
    });
  });
});
