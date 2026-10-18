import { describe, expect, it } from "vitest";
import { insertDeload } from "../../src/plan/deload.js";
import type { PlanContent } from "../../src/plan/types.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import { buildContent } from "./helpers.js";

function invariants(c: PlanContent) {
  expect(c.weeks.map((w) => w.week)).toEqual(c.weeks.map((_, i) => i + 1));
  for (const w of c.weeks) expect(w.startDate).toBe(addDays("2026-09-28", 7 * (w.week - 1)));
  const keys = c.items.map((i) => i.itemKey);
  expect(new Set(keys).size).toBe(keys.length);
  for (const i of c.items) expect(c.weeks.some((w) => w.week === i.week)).toBe(true);
}
const deloads = (c: PlanContent) => c.weeks.filter((w) => w.isDeload).map((w) => w.week);

describe("insertDeload", () => {
  it("at 7 drops old W8", () => {
    const src = buildContent();
    const { content: c, droppedWeek } = insertDeload(src, 7);
    invariants(c);
    expect(c.weeks).toHaveLength(12);
    expect(droppedWeek).toBe(8);
    expect(c.weeks[6]).toMatchObject({ isDeload: true, phase: "Deload", isTest: false });
    const w7 = c.items.filter((i) => i.week === 7);
    const old8 = src.items.filter((i) => i.week === 8);
    expect(w7.map((i) => i.itemKey)).toEqual(old8.map((i) => i.itemKey.replace("w08", "d07")));
    expect(w7.map((i) => ({ ...i, itemKey: "", week: 0 }))).toEqual(
      old8.map((i) => ({ ...i, itemKey: "", week: 0 })),
    );
    const w8 = c.items.filter((i) => i.week === 8);
    expect(w8.map((i) => i.itemKey)).toEqual(
      src.items.filter((i) => i.week === 7).map((i) => i.itemKey),
    );
    expect(deloads(c)).toEqual([4, 7]);
    expect(c.weeks[11]?.isTest).toBe(true);
    expect(c.items.filter((i) => i.week === 9).map((i) => i.itemKey)).toEqual(
      src.items.filter((i) => i.week === 9).map((i) => i.itemKey),
    );
  });

  it("at 6 keeps W8 (21 days)", () => {
    const { content: c, droppedWeek } = insertDeload(buildContent(), 6);
    invariants(c);
    expect(c.weeks).toHaveLength(13);
    expect(deloads(c)).toEqual([4, 6, 9]);
    expect(droppedWeek).toBeNull();
  });

  it("at 11 uses old W8 as template", () => {
    const src = buildContent();
    const { content: c, droppedWeek } = insertDeload(src, 11);
    invariants(c);
    expect(c.weeks).toHaveLength(13);
    expect(droppedWeek).toBeNull();
    expect(c.weeks[12]?.isTest).toBe(true);
    expect(c.items.filter((i) => i.week === 11).map((i) => i.planName)).toEqual(
      src.items.filter((i) => i.week === 8).map((i) => i.planName),
    );
  });

  it("at 12 never drops the test week", () => {
    const { content: c, droppedWeek } = insertDeload(buildContent(), 12);
    invariants(c);
    expect(c.weeks).toHaveLength(13);
    expect(droppedWeek).toBeNull();
    expect(c.weeks[12]?.isTest).toBe(true);
    expect(c.weeks[11]?.isDeload).toBe(true);
  });

  it("throws when the week at insertAt is already a deload", () => {
    expect(() => insertDeload(buildContent(), 8)).toThrow(/already a deload/);
  });

  it("throws for insertAt out of range", () => {
    for (const at of [0, 1, 13])
      expect(() => insertDeload(buildContent(), at)).toThrow(/Cannot insert/);
  });

  it("keeps a nearby deload that is also the test week", () => {
    const src = buildContent();
    const w8 = src.weeks[7];
    if (w8) w8.isTest = true;
    const { content: c, droppedWeek } = insertDeload(src, 7);
    invariants(c);
    expect(droppedWeek).toBeNull();
    expect(c.weeks).toHaveLength(13);
    expect(c.weeks[8]?.isTest).toBe(true);
  });

  it("keeps keys unique over repeated inserts", () => {
    let c = buildContent();
    for (const at of [7, 5, 6, 7]) {
      c = insertDeload(c, at).content;
      invariants(c);
    }
    const keys = c.items.map((i) => i.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws without any deload", () => {
    const src = buildContent();
    src.weeks.forEach((w) => {
      w.isDeload = false;
    });
    expect(() => insertDeload(src, 5)).toThrow();
  });
});
