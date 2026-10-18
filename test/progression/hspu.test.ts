import { describe, expect, it } from "vitest";
import { hspuReps, hspuState, shouldProposeAdvance } from "../../src/progression/hspu.js";
import type { SessionRec } from "../../src/progression/types.js";
import { LADDER, session, set, target } from "./helpers-skill.js";

const clean = (n: number, reps: number) =>
  Array.from({ length: n }, () => set({ reps, clean: true }));
const hs = (date: string, step: number, p: Partial<SessionRec> = {}) =>
  session({ date, hspuStepOrder: step, padHeight: 10, sets: clean(4, 4), ...p });

describe("hspuState", () => {
  it("null when never logged", () => {
    expect(hspuState([])).toEqual({ stepOrder: null, padHeight: null });
    expect(hspuState([session({ date: "2026-10-06" })]).stepOrder).toBeNull();
  });
  it("comes from the last log", () => {
    const s = hspuState([
      session({ date: "2026-10-13", hspuStepOrder: 4, padHeight: 8 }),
      session({ date: "2026-10-06", hspuStepOrder: 3, padHeight: 10 }),
    ]);
    expect(s).toEqual({ stepOrder: 4, padHeight: 8 });
  });
  it("is order independent and falls back to the latest known pad", () => {
    const s = hspuState([
      session({ date: "2026-10-06", hspuStepOrder: 3, padHeight: 10 }),
      session({ date: "2026-10-13", hspuStepOrder: 4, padHeight: null }),
    ]);
    expect(s).toEqual({ stepOrder: 4, padHeight: 10 });
  });
  it("re-import rebuilds the step from imported sessions (pure)", () => {
    const imported = [session({ date: "2026-09-29", source: "import", hspuStepOrder: 2 })];
    expect(hspuState(imported).stepOrder).toBe(2);
    const withBot = [session({ date: "2026-10-06", hspuStepOrder: 3 }), ...imported];
    expect(hspuState(withBot).stepOrder).toBe(3);
    expect(hspuState(withBot.slice(1)).stepOrder).toBe(2);
  });
});

describe("hspuReps", () => {
  const t = target({ setsMax: 4, setsMin: 4, repsMin: 3, repsMax: 5, hspuStepOrder: 4 });
  it("plan reps when state step == plan step", () => {
    expect(hspuReps({ stepOrder: 4, padHeight: null }, t, LADDER)).toMatchObject({
      sets: 4,
      repsMin: 3,
      repsMax: 5,
      fromPlan: true,
    });
  });
  it("step defaults and tempo when on a different step", () => {
    expect(hspuReps({ stepOrder: 3, padHeight: null }, t, LADDER)).toEqual({
      sets: 3,
      repsMin: 3,
      repsMax: 3,
      tempo: "5s down",
      fromPlan: false,
    });
  });
  it("plan reps when the plan names no step or nothing logged", () => {
    expect(
      hspuReps({ stepOrder: 2, padHeight: null }, { ...t, hspuStepOrder: null }, LADDER).fromPlan,
    ).toBe(true);
    expect(hspuReps({ stepOrder: null, padHeight: null }, t, LADDER).fromPlan).toBe(true);
  });
});

describe("shouldProposeAdvance", () => {
  const state = { stepOrder: 4, padHeight: 10 };
  const t = target({ setsMax: 4, repsMin: 3, repsMax: 4, hspuStepOrder: 4 });
  it("proposes the next step after 2 clean sessions at target", () => {
    const sessions = [hs("2026-10-13", 4), hs("2026-10-06", 4)];
    expect(shouldProposeAdvance(sessions, state, t, LADDER)).toEqual({
      fromStepOrder: 4,
      toStepOrder: 5,
    });
  });
  it("not after only 1 clean session", () => {
    expect(shouldProposeAdvance([hs("2026-10-13", 4)], state, t, LADDER)).toBeNull();
  });
  it("not when a set is below reps_max or unclean", () => {
    const short = hs("2026-10-13", 4, { sets: [...clean(3, 4), set({ reps: 3, clean: true })] });
    expect(shouldProposeAdvance([short, hs("2026-10-06", 4)], state, t, LADDER)).toBeNull();
    const dirty = hs("2026-10-13", 4, { sets: [...clean(3, 4), set({ reps: 4, clean: false })] });
    expect(shouldProposeAdvance([dirty, hs("2026-10-06", 4)], state, t, LADDER)).toBeNull();
  });
  it("not when the earlier session was on another step", () => {
    expect(
      shouldProposeAdvance([hs("2026-10-13", 4), hs("2026-10-06", 3)], state, t, LADDER),
    ).toBeNull();
  });
  it("deload never advances: deload week target, and deload sessions do not count", () => {
    const sessions = [hs("2026-10-13", 4), hs("2026-10-06", 4)];
    expect(shouldProposeAdvance(sessions, state, { ...t, isDeload: true }, LADDER)).toBeNull();
    const withDeload = [hs("2026-10-20", 4, { isDeload: true }), hs("2026-10-13", 4)];
    expect(shouldProposeAdvance(withDeload, state, t, LADDER)).toBeNull();
  });
  it("a deload session in between does not break the streak", () => {
    const sessions = [
      hs("2026-10-20", 4),
      hs("2026-10-13", 4, { isDeload: true }),
      hs("2026-10-06", 4),
    ];
    expect(shouldProposeAdvance(sessions, state, t, LADDER)).toEqual({
      fromStepOrder: 4,
      toStepOrder: 5,
    });
  });
  it("no proposal on the last step or with no state", () => {
    const top = { stepOrder: 6, padHeight: null };
    const tt = target({ repsMax: 4, hspuStepOrder: 6 });
    expect(
      shouldProposeAdvance([hs("2026-10-13", 6), hs("2026-10-06", 6)], top, tt, LADDER),
    ).toBeNull();
    expect(shouldProposeAdvance([], { stepOrder: null, padHeight: null }, t, LADDER)).toBeNull();
  });
  it("target reps_max follows the step defaults when off-plan", () => {
    // on step 3 (3x3 negatives) while plan names step 4: target max = 3
    const s3 = { stepOrder: 3, padHeight: null };
    const mk = (d: string) => hs(d, 3, { sets: clean(3, 3) });
    expect(shouldProposeAdvance([mk("2026-10-13"), mk("2026-10-06")], s3, t, LADDER)).toEqual({
      fromStepOrder: 3,
      toStepOrder: 4,
    });
  });
});
