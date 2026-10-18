import { describe, expect, it } from "vitest";
import { suggestMainLoad } from "../../src/progression/load.js";
import { barbell, dumbbell, pullup, target } from "./helpers-load.js";

describe("suggestMainLoad weighted", () => {
  it("e1rm / (1 + (repsMin + rirMid)/30), rounded toward easier", () => {
    // 120 / (1 + 6.5/30) = 98.63 -> 97.5
    const s = suggestMainLoad(120, target(), barbell(), 80, 1.5);
    expect(s.loadKg).toBe(97.5);
    expect(s.systemLoad).toBe(97.5);
    expect(s.sets).toBe(4);
    expect(s.repsMin).toBe(5);
    expect(s.rirMin).toBe(1);
    expect(s.rirMax).toBe(2);
    expect(s.e1rmUsed).toBe(120);
    expect(s.labels).toEqual([]);
  });
  it("same e1RM, different reps gives different loads (Tue vs Fri squat)", () => {
    const tue = suggestMainLoad(150, target({ repsMin: 5, repsMax: 5 }), barbell(), 80, 1.5);
    const fri = suggestMainLoad(150, target({ repsMin: 8, repsMax: 8 }), barbell(), 80, 1.5);
    expect(fri.loadKg as number).toBeLessThan(tue.loadKg as number);
  });
  it("per-hand dumbbell lands on a rack value", () => {
    const s = suggestMainLoad(30, target({ repsMin: 8 }), dumbbell(), 80, 2);
    expect(dumbbell().equipment?.discreteValues).toContain(s.loadKg);
  });
  it("a lower e1RM (after misses) gives a lower load", () => {
    const hi = suggestMainLoad(130, target(), barbell(), 80, 1.5).loadKg as number;
    const lo = suggestMainLoad(115, target(), barbell(), 80, 1.5).loadKg as number;
    expect(lo).toBeLessThan(hi);
  });
});

describe("suggestMainLoad bodyweight_plus", () => {
  const t = target({ repsMin: 5, rirMin: 1, rirMax: 2 });
  it("positive diff -> added weight rounded down", () => {
    // 120/(1+6.5/30)=98.63 ; bw 80 -> 18.63 -> 18.75? step1.25: 17.5
    const s = suggestMainLoad(120, t, pullup(), 80, 1.5);
    expect(s.addedKg).toBe(17.5);
    expect(s.systemLoad).toBe(97.5);
    expect(s.assistKg).toBeUndefined();
  });
  it("negative diff with closed gate -> assistance band", () => {
    // needed 98.63 vs bw 105 -> assist 6.37 -> red (10)
    const s = suggestMainLoad(120, t, pullup(), 105, 1.5);
    expect(s.assistKg).toBe(10);
    expect(s.band).toBe("red");
    expect(s.systemLoad).toBe(95);
  });
  it("negative diff with open gate -> plain bodyweight", () => {
    const s = suggestMainLoad(120, t, pullup(), 105, 1.5, { gateOpen: true });
    expect(s.addedKg).toBe(0);
    expect(s.assistKg).toBeUndefined();
    expect(s.systemLoad).toBe(105);
  });
  it("assistance beyond the biggest band -> ask band", () => {
    expect(suggestMainLoad(60, t, pullup(), 105, 1.5).ask).toBe("band");
  });
  it("missing bodyweight -> ask bodyweight", () => {
    const s = suggestMainLoad(120, t, pullup(), null, 1.5);
    expect(s.ask).toBe("bodyweight");
    expect(s.addedKg).toBeUndefined();
  });
});
