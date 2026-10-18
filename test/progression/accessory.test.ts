import { describe, expect, it } from "vitest";
import { accessoryStep, applyStep } from "../../src/progression/accessory.js";
import { dumbbell, session, set, stack, target } from "./helpers-load.js";

const t = target({ repsMin: 8, repsMax: 12, rirMin: 1, rirMax: 3, setsMin: 3, setsMax: 3 });
const sess = (reps: number[], lastRir: number, p = {}) =>
  session(2, {
    sets: reps.map((r, i) =>
      set({ reps: r, rir: i === reps.length - 1 ? lastRir : null, loadKg: 14 }),
    ),
    ...p,
  });

describe("accessoryStep", () => {
  it("+1 when all sets hit reps_max and last RIR >= rir_min", () => {
    expect(accessoryStep([sess([12, 12, 12], 1)], t)).toBe(1);
  });
  it("keep when RIR too low for increase or a set under max", () => {
    expect(accessoryStep([sess([12, 12, 12], 0)], t)).toBe(0);
    expect(accessoryStep([sess([12, 11, 12], 2)], t)).toBe(0);
  });
  it("-1 when any set below reps_min", () => {
    expect(accessoryStep([sess([10, 9, 7], 1)], t)).toBe(-1);
  });
  it("-1 when last-set RIR 0 in 2 sessions in a row, keep after only one", () => {
    expect(accessoryStep([sess([10, 9, 9], 0), sess([10, 9, 9], 0)], t)).toBe(-1);
    expect(accessoryStep([sess([10, 9, 9], 0), sess([10, 9, 9], 1)], t)).toBe(0);
  });
  it("deload logs don't trigger increases", () => {
    expect(accessoryStep([sess([12, 12, 12], 3, { isDeload: true })], t)).toBe(0);
  });
  it("no history -> 0", () => {
    expect(accessoryStep([], t)).toBe(0);
  });
});

describe("applyStep", () => {
  it("steps per equipment", () => {
    expect(applyStep(14, 1, dumbbell())).toBe(16);
    expect(applyStep(14, -1, dumbbell())).toBe(12);
    expect(applyStep(14, 0, dumbbell())).toBe(14);
    expect(applyStep(40, 1, stack())).toBe(45);
    expect(applyStep(40, -1, stack())).toBe(35);
  });
});
