import { describe, expect, it } from "vitest";
import { applySwap, itemDate } from "../../src/plan/swap-transform.js";
import type { ItemSpec } from "../../src/plan/types.js";
import { buildContent, makeItem } from "./helpers.js";

describe("applySwap", () => {
  const base = () => {
    const c = buildContent();
    c.items = c.items.map((i) =>
      i.itemOrder === 1 ? { ...i, optionExerciseIds: [1, 2], hspuStepId: 9 } : i,
    );
    return c;
  };
  const swap = {
    fromExerciseId: 2,
    toExerciseId: 3,
    weekdays: "all" as const,
    clearHspuStep: false,
    rirFor: () => ({ rirMin: 7, rirMax: 8 }),
  };

  it("itemDate = week start + weekday offset", () => {
    const c = buildContent();
    expect(itemDate(c, makeItem(1, "fri", 1))).toBe("2026-10-02");
    expect(itemDate(c, makeItem(2, "tue", 1))).toBe("2026-10-06");
  });

  it("swaps from fromDate on, keeps earlier items", () => {
    const c = base();
    const { content, changedItems } = applySwap(c, { ...swap, fromDate: "2026-10-06" });
    for (const [n, i] of content.items.entries()) {
      const o = c.items[n] as ItemSpec;
      expect(i.itemKey).toBe(o.itemKey);
      if (itemDate(c, o) < "2026-10-06" || o.itemOrder !== 1) expect(i).toEqual(o);
      else expect(i.optionExerciseIds).toEqual([1, 3]);
    }
    expect(changedItems).toBe(content.items.filter((i) => i.optionExerciseIds[1] === 3).length);
    expect(changedItems).toBeGreaterThan(0);
  });

  it("does not duplicate when `to` is already an option", () => {
    const c = base();
    c.items[0] = { ...(c.items[0] as ItemSpec), optionExerciseIds: [3, 2] };
    const { content } = applySwap(c, { ...swap, fromDate: "2026-09-28" });
    expect(content.items[0]?.optionExerciseIds).toEqual([3]);
  });

  it("filters by weekday", () => {
    const { content } = applySwap(base(), { ...swap, weekdays: ["tue"], fromDate: "2026-09-28" });
    expect(
      content.items.filter((i) => i.weekday === "fri" && i.optionExerciseIds.includes(3)),
    ).toHaveLength(0);
    expect(
      content.items.filter((i) => i.weekday === "tue" && i.optionExerciseIds.includes(3)),
    ).not.toHaveLength(0);
  });

  it("clearHspuStep nulls only changed items", () => {
    const { content } = applySwap(base(), {
      ...swap,
      clearHspuStep: true,
      weekdays: ["tue"],
      fromDate: "2026-09-28",
    });
    for (const i of content.items) {
      const changed = i.optionExerciseIds.includes(3);
      expect(i.hspuStepId).toBe(i.itemOrder === 1 && !changed ? 9 : changed ? null : i.hspuStepId);
    }
    expect(content.items.find((i) => i.weekday === "mon" && i.itemOrder === 1)?.hspuStepId).toBe(9);
    expect(
      content.items.find((i) => i.weekday === "tue" && i.itemOrder === 1)?.hspuStepId,
    ).toBeNull();
  });

  it("recomputes RIR via rirFor only on changed items", () => {
    const calls: Array<{ ids: number[]; deload: boolean }> = [];
    const c = base();
    const { content } = applySwap(c, {
      ...swap,
      fromDate: "2026-10-06",
      rirFor: (_item, ids, deload) => {
        calls.push({ ids, deload });
        return { rirMin: 7, rirMax: 8 };
      },
    });
    let changed = 0;
    for (const [n, i] of content.items.entries()) {
      const o = c.items[n] as ItemSpec;
      if (i.optionExerciseIds.includes(3)) {
        changed++;
        expect([i.rirMin, i.rirMax]).toEqual([7, 8]);
      } else expect(i).toEqual(o);
    }
    expect(calls).toHaveLength(changed);
    expect(calls.every((x) => x.ids.includes(3) && !x.ids.includes(2))).toBe(true);
  });

  it("passes the week's isDeload flag to rirFor", () => {
    const c = base();
    c.weeks = c.weeks.map((w) => (w.week === 2 ? { ...w, isDeload: true } : w));
    const seen = new Set<string>();
    applySwap(c, {
      ...swap,
      fromDate: "2026-09-28",
      rirFor: (item, _ids, deload) => {
        seen.add(`${item.week}:${deload}`);
        return { rirMin: null, rirMax: null };
      },
    });
    expect(seen.has("2:true")).toBe(true);
    expect(seen.has("1:false")).toBe(true);
    expect(seen.has("2:false")).toBe(false);
  });

  it("clearHspuStep nulls fallbackPrescription on changed items only", () => {
    const fb = { kind: "x" } as unknown as ItemSpec["fallbackPrescription"];
    const c = base();
    c.items = c.items.map((i) => ({ ...i, fallbackPrescription: fb }));
    const run = (clearHspuStep: boolean) =>
      applySwap(c, { ...swap, clearHspuStep, weekdays: ["tue"], fromDate: "2026-09-28" }).content;
    for (const i of run(true).items) {
      expect(i.fallbackPrescription).toEqual(i.optionExerciseIds.includes(3) ? null : fb);
    }
    for (const i of run(false).items) expect(i.fallbackPrescription).toEqual(fb);
  });
});
