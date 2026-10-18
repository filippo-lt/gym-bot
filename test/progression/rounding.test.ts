import { describe, expect, it } from "vitest";
import { roundLoadDown, roundTowardEasier, stepLoad } from "../../src/progression/rounding.js";
import { barbell, dumbbell, pullup, stack } from "./helpers-load.js";

describe("barbell", () => {
  it("bar + k*step, rounds down", () => {
    expect(roundTowardEasier({ loadKg: 63.9 }, barbell()).loadKg).toBe(62.5);
    expect(roundTowardEasier({ loadKg: 62.5 }, barbell()).loadKg).toBe(62.5);
  });
  it("uses base offset (step 5 total)", () => {
    expect(roundTowardEasier({ loadKg: 69.9 }, barbell(1, { baseKg: 20, stepKg: 5 })).loadKg).toBe(
      65,
    );
  });
  it("never below the bar", () => {
    expect(roundTowardEasier({ loadKg: 12 }, barbell()).loadKg).toBe(20);
  });
});

describe("per-hand dumbbells and stack", () => {
  it("floors to the nearest lower discrete value", () => {
    expect(roundTowardEasier({ loadKg: 13.9 }, dumbbell()).loadKg).toBe(12);
    expect(roundTowardEasier({ loadKg: 14 }, dumbbell()).loadKg).toBe(14);
    expect(roundTowardEasier({ loadKg: 99 }, dumbbell()).loadKg).toBe(20);
  });
  it("never mixes into pairs: result is a single-dumbbell value from the rack", () => {
    const r = roundTowardEasier({ loadKg: 17 }, dumbbell()).loadKg as number;
    expect(dumbbell().equipment?.discreteValues).toContain(r);
    expect(r).toBe(16);
  });
  it("below the lowest value stays at the lowest", () => {
    expect(roundTowardEasier({ loadKg: 5 }, dumbbell()).loadKg).toBe(8);
  });
  it("stack with step floors to step", () => {
    expect(roundTowardEasier({ loadKg: 47 }, stack()).loadKg).toBe(45);
  });
  it("negative loads round toward easier (more negative)", () => {
    expect(roundTowardEasier({ loadKg: -12.3 }, stack(3, { stepKg: 2.5 })).loadKg).toBe(-12.5);
  });
});

describe("bodyweight_plus", () => {
  it("added floors to the equipment step", () => {
    expect(roundTowardEasier({ addedKg: 7.4 }, pullup()).addedKg).toBe(6.25);
  });
  it("assistance rounds up to the smallest band >= needed", () => {
    const r = roundTowardEasier({ assistKg: 12 }, pullup());
    expect(r).toEqual({ assistKg: 20, band: "black" });
    expect(roundTowardEasier({ assistKg: 10 }, pullup())).toEqual({ assistKg: 10, band: "red" });
  });
  it("needed assistance larger than any band -> ask band", () => {
    expect(roundTowardEasier({ assistKg: 35 }, pullup()).ask).toBe("band");
  });
  it("no bands mapped -> ask band", () => {
    expect(roundTowardEasier({ assistKg: 5 }, pullup(4, { bands: {} })).ask).toBe("band");
  });
  it("zero assistance needs no band", () => {
    expect(roundTowardEasier({ assistKg: 0 }, pullup())).toEqual({ assistKg: 0 });
  });
  it("negative added is read as assistance", () => {
    const r = roundTowardEasier({ addedKg: -4 }, pullup());
    expect(r.addedKg).toBe(0);
    expect(r.assistKg).toBe(10);
    expect(r.band).toBe("red");
  });
});

describe("stepLoad", () => {
  it("moves along the grid", () => {
    expect(stepLoad(60, 1, barbell())).toBe(62.5);
    expect(stepLoad(60, -1, barbell())).toBe(57.5);
    expect(stepLoad(20, -1, barbell())).toBe(20);
    expect(stepLoad(12, 1, dumbbell())).toBe(14);
    expect(stepLoad(20, 1, dumbbell())).toBe(20);
    expect(stepLoad(8, -1, dumbbell())).toBe(8);
    expect(stepLoad(23, 1, stack(3, { stepKg: 2.5 }))).toBe(25);
  });
  it("roundLoadDown without equipment keeps the value", () => {
    expect(roundLoadDown(33.456, { ...barbell(), equipment: null })).toBe(33.45);
  });
});
