import { describe, expect, it } from "vitest";
import {
  currentE1rm,
  sessionEstimate,
  setE1rm,
  systemLoadOf,
  validSets,
} from "../../src/progression/e1rm.js";
import { barbell, dumbbell, pullup, session, set } from "./helpers-load.js";

const sq = barbell(1);
const e = (load: number, reps: number, rir: number) => setE1rm(load, reps, rir);

describe("setE1rm / systemLoadOf", () => {
  it("Epley with RIR", () => {
    expect(setE1rm(100, 5, 1)).toBeCloseTo(120);
  });
  it("weighted uses loadKg", () => {
    expect(systemLoadOf(set({ loadKg: 60 }), sq, 80)).toBe(60);
  });
  it("bodyweight_plus = bw + added - assist", () => {
    const p = pullup();
    expect(systemLoadOf(set({ loadKg: null, addedKg: 10 }), p, 80)).toBe(90);
    expect(systemLoadOf(set({ loadKg: null, assistKg: 15 }), p, 80)).toBe(65);
    expect(systemLoadOf(set({ loadKg: null, addedKg: 10 }), p, null)).toBeNull();
  });
  it("mapped band gives assistance, unmapped band is not usable", () => {
    const p = pullup();
    expect(systemLoadOf(set({ loadKg: null, band: "black", assistKg: 0 }), p, 80)).toBe(60);
    expect(systemLoadOf(set({ loadKg: null, band: "pink", assistKg: 0 }), p, 80)).toBeNull();
  });
});

describe("validSets", () => {
  const ok = set({ reps: 5, rir: 2 });
  it("keeps sets with RIR and reps <= 15", () => {
    const s = session(1, {
      sets: [ok, set({ rir: null }), set({ reps: 16 }), set({ reps: 15 }), set({ clean: false })],
    });
    expect(validSets(s, sq)).toHaveLength(2);
  });
  it("drops deload, test, RED and per-set-unknown sessions", () => {
    for (const p of [
      { isDeload: true },
      { isTest: true },
      { readiness: "RED" as const },
      { perSetUnknown: true },
    ]) {
      expect(validSets(session(1, { ...p, sets: [ok] }), sq)).toHaveLength(0);
    }
    expect(validSets(session(1, { readiness: "YELLOW", sets: [ok] }), sq)).toHaveLength(1);
  });
  it("one spoken RIR belongs to the last set only", () => {
    const s = session(1, {
      source: "import",
      sets: [
        set({ rir: null, loadKg: 100 }),
        set({ rir: null, loadKg: 100 }),
        set({ rir: 2, loadKg: 100 }),
      ],
    });
    expect(validSets(s, sq)).toHaveLength(1);
  });
  it("drops unmapped band sets", () => {
    const s = session(4, {
      sets: [set({ loadKg: null, band: "pink" }), set({ loadKg: null, band: "red" })],
    });
    expect(validSets(s, pullup())).toHaveLength(1);
  });
  it("no load math types yield nothing", () => {
    const ex = { ...sq, type: "bodyweight_reps" as const };
    expect(validSets(session(1), ex)).toHaveLength(0);
  });
});

describe("sessionEstimate", () => {
  it("highest valid set", () => {
    const s = session(1, {
      sets: [set({ loadKg: 100, reps: 5, rir: 2 }), set({ loadKg: 105, reps: 5, rir: 1 })],
    });
    expect(sessionEstimate(s, sq).strict).toBeCloseTo(e(105, 5, 1));
  });
  it("4+ appears only in withPlus", () => {
    const s = session(1, { sets: [set({ loadKg: 100, reps: 5, rir: 4, rirPlus: true })] });
    const est = sessionEstimate(s, sq);
    expect(est.strict).toBeNull();
    expect(est.withPlus).toBeCloseTo(e(100, 5, 4));
  });
  it("deload and test weeks produce nothing", () => {
    expect(sessionEstimate(session(1, { isDeload: true }), sq)).toEqual({
      strict: null,
      withPlus: null,
    });
    expect(sessionEstimate(session(1, { isTest: true }), sq)).toEqual({
      strict: null,
      withPlus: null,
    });
  });
});

describe("currentE1rm", () => {
  const s = (load: number, extra = {}) =>
    session(1, { sets: [set({ loadKg: load, reps: 5, rir: 1 })], ...extra });
  it("none -> null", () => {
    expect(currentE1rm([], sq)).toBeNull();
    expect(currentE1rm([session(1, { isDeload: true })], sq)).toBeNull();
  });
  it("single / lower of 2 / median of last 3", () => {
    expect(currentE1rm([s(100)], sq)?.basis).toBe("single");
    const two = currentE1rm([s(110), s(100)], sq);
    expect(two?.basis).toBe("lower2");
    expect(two?.value).toBeCloseTo(e(100, 5, 1));
    const three = currentE1rm([s(90), s(120), s(100), s(200)], sq);
    expect(three?.basis).toBe("median3");
    expect(three?.value).toBeCloseTo(e(100, 5, 1));
  });
  it("deload/test sessions do not change e1RM", () => {
    const base = [s(100), s(100)];
    const withDeload = [s(60, { isDeload: true }), ...base, s(200, { isTest: true })];
    expect(currentE1rm(withDeload, sq)?.value).toBeCloseTo(currentE1rm(base, sq)?.value as number);
  });
  it("a miss (fewer reps) lowers the estimate", () => {
    const good = currentE1rm([s(100), s(100), s(100)], sq)?.value as number;
    const miss = session(1, { sets: [set({ loadKg: 100, reps: 3, rir: 0 })] });
    expect(currentE1rm([miss, s(100), s(100)], sq)?.value as number).toBeLessThanOrEqual(good);
    expect(currentE1rm([miss, miss, s(100)], sq)?.value as number).toBeLessThan(good);
  });
  it("4+ raises but never lowers", () => {
    const base = [s(100), s(100)];
    const lowPlus = session(1, { sets: [set({ loadKg: 60, reps: 5, rir: 4, rirPlus: true })] });
    const lowered = currentE1rm([lowPlus, ...base], sq)?.value as number;
    expect(lowered).toBeCloseTo(currentE1rm(base, sq)?.value as number);
    const highPlus = session(1, { sets: [set({ loadKg: 120, reps: 5, rir: 4, rirPlus: true })] });
    const uneven = [s(100), s(90)];
    expect(currentE1rm([highPlus, ...uneven], sq)?.value as number).toBeGreaterThan(
      currentE1rm(uneven, sq)?.value as number,
    );
  });
  it("importedOnly until 2 bot sessions", () => {
    const imp = (l: number) => s(l, { source: "import" });
    expect(currentE1rm([imp(100), imp(100)], sq)?.importedOnly).toBe(true);
    expect(currentE1rm([s(100), imp(100)], sq)?.importedOnly).toBe(true);
    const r = currentE1rm([s(100), s(100), imp(100)], sq);
    expect(r?.importedOnly).toBe(false);
    expect(r?.botSessions).toBe(2);
  });
  it("pull-up uses system load", () => {
    const p = pullup();
    const sess = session(4, {
      bwKg: 80,
      sets: [set({ loadKg: null, addedKg: 10, reps: 5, rir: 1 })],
    });
    expect(currentE1rm([sess], p)?.value).toBeCloseTo(e(90, 5, 1));
  });
  it("hack squat sessions are a separate exercise and never feed squat", () => {
    const hack = barbell(9);
    const hackHist = [session(9, { sets: [set({ loadKg: 200, reps: 5, rir: 1 })] })];
    const squatHist = [s(100)];
    expect(currentE1rm(squatHist, sq)?.value).toBeCloseTo(e(100, 5, 1));
    expect(currentE1rm(hackHist, hack)?.value).toBeCloseTo(e(200, 5, 1));
  });
  it("per-hand dumbbells are used as the per-hand value", () => {
    const db = dumbbell();
    const sess = session(2, { sets: [set({ loadKg: 20, reps: 8, rir: 2 })] });
    expect(currentE1rm([sess], db)?.value).toBeCloseTo(e(20, 8, 2));
  });
});
