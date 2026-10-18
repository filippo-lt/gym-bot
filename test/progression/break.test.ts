import { describe, expect, it } from "vitest";
import { applyBreak, breakApplies } from "../../src/progression/break.js";
import type { Suggestion } from "../../src/progression/types.js";
import { barbell, pullup } from "./helpers-load.js";

const sug = (p: Partial<Suggestion>): Suggestion => ({
  sets: 4,
  repsMin: 5,
  repsMax: 5,
  rirMin: 1,
  rirMax: 2,
  labels: [],
  ...p,
});

describe("breakApplies", () => {
  it("2 missed occurrences in a row", () => {
    const occ = [
      { date: "2026-10-05", logged: true },
      { date: "2026-10-12", logged: false },
      { date: "2026-10-19", logged: false },
    ];
    expect(
      breakApplies({ occurrences: occ, lastTrainingDate: "2026-10-22", asOf: "2026-10-26" }),
    ).toBe(true);
  });
  it("one miss, or miss then logged, does not fire", () => {
    const one = [{ date: "2026-10-19", logged: false }];
    expect(
      breakApplies({ occurrences: one, lastTrainingDate: "2026-10-22", asOf: "2026-10-26" }),
    ).toBe(false);
    const recovered = [
      { date: "2026-10-05", logged: false },
      { date: "2026-10-12", logged: false },
      { date: "2026-10-19", logged: true },
    ];
    expect(
      breakApplies({ occurrences: recovered, lastTrainingDate: "2026-10-22", asOf: "2026-10-26" }),
    ).toBe(false);
  });
  it("10+ days without training fires, 9 does not", () => {
    expect(
      breakApplies({ occurrences: [], lastTrainingDate: "2026-10-16", asOf: "2026-10-26" }),
    ).toBe(true);
    expect(
      breakApplies({ occurrences: [], lastTrainingDate: "2026-10-17", asOf: "2026-10-26" }),
    ).toBe(false);
    expect(breakApplies({ occurrences: [], lastTrainingDate: null, asOf: "2026-10-26" })).toBe(
      false,
    );
  });
  it("W5 Monday (26 Oct) after full W1-W4 history: no break", () => {
    // W4 deload week excluded by caller; occurrences are W1-W3 Mondays all logged; last training Fri 23 Oct.
    const occ = ["2026-09-28", "2026-10-05", "2026-10-12"].map((date) => ({ date, logged: true }));
    expect(
      breakApplies({ occurrences: occ, lastTrainingDate: "2026-10-23", asOf: "2026-10-26" }),
    ).toBe(false);
  });
  it("W9 Monday (23 Nov) after full W5-W8 history: no break", () => {
    const occ = ["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"].map((date) => ({
      date,
      logged: true,
    }));
    expect(
      breakApplies({ occurrences: occ, lastTrainingDate: "2026-11-20", asOf: "2026-11-23" }),
    ).toBe(false);
  });
  it("Curl OR triceps alternating weekly never triggers (occurrence logged if any option logged)", () => {
    const occ = ["2026-10-05", "2026-10-12", "2026-10-19"].map((date) => ({ date, logged: true }));
    expect(
      breakApplies({ occurrences: occ, lastTrainingDate: "2026-10-22", asOf: "2026-10-26" }),
    ).toBe(false);
  });
  it("deload week never triggers", () => {
    const occ = [
      { date: "2026-10-05", logged: false },
      { date: "2026-10-12", logged: false },
    ];
    expect(
      breakApplies({
        occurrences: occ,
        lastTrainingDate: "2026-09-01",
        asOf: "2026-10-19",
        isDeload: true,
      }),
    ).toBe(false);
  });
});

describe("applyBreak", () => {
  it("weighted: -10% rounded toward easier, labelled", () => {
    const out = applyBreak(sug({ loadKg: 100, systemLoad: 100 }), barbell(), 80);
    expect(out.loadKg).toBe(90);
    expect(out.systemLoad).toBe(90);
    expect(out.labels).toEqual(["back_after_break"]);
    // 97.5 * 0.9 = 87.75 -> 87.5
    expect(applyBreak(sug({ loadKg: 97.5 }), barbell(), 80).loadKg).toBe(87.5);
  });
  it("pull-up: 10% of system load comes off added weight only", () => {
    // bw 80 + 20 = 100 -> cut 10 -> added 10
    const out = applyBreak(sug({ addedKg: 20, systemLoad: 100 }), pullup(), 80);
    expect(out.addedKg).toBe(10);
    expect(out.systemLoad).toBe(90);
    expect(out.assistKg).toBeUndefined();
  });
  it("pull-up: floored at 0, assistance untouched", () => {
    const out = applyBreak(sug({ addedKg: 5, systemLoad: 85 }), pullup(), 80);
    expect(out.addedKg).toBe(0);
    expect(out.systemLoad).toBe(80);
    const a = applyBreak(
      sug({ addedKg: 0, assistKg: 10, band: "red", systemLoad: 70 }),
      pullup(),
      80,
    );
    expect(a.addedKg).toBe(0);
    expect(a.assistKg).toBe(10);
    expect(a.band).toBe("red");
  });
  it("pull-up cut is rounded toward easier to the step", () => {
    // 90 + 10.3 added... bw 80 added 11 -> system 91, cut 9.1 -> 1.9 -> 1.25
    expect(applyBreak(sug({ addedKg: 11, systemLoad: 91 }), pullup(), 80).addedKg).toBe(1.25);
  });
  it("ask-suggestions only get the label", () => {
    const out = applyBreak(sug({ ask: "load" }), barbell(), 80);
    expect(out.labels).toEqual(["back_after_break"]);
    expect(out.loadKg).toBeUndefined();
  });
});
