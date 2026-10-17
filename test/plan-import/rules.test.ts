import { describe, expect, it } from "vitest";
import { CATALOG_BY_SLUG } from "../../src/plan-import/exercise-catalog.js";
import { fallbackFor } from "../../src/plan-import/fallback.js";
import { matchHspuPrefix } from "../../src/plan-import/hspu.js";
import { computeRir } from "../../src/plan-import/rir.js";
import type { Modifier } from "../../src/plan-import/types.js";

function rir(slugs: string[], modifiers: Modifier[] = [], weekIsDeload = false) {
  const options = slugs.map((s) => {
    const c = CATALOG_BY_SLUG.get(s);
    if (!c) throw new Error(s);
    return c;
  });
  return computeRir({ options, modifiers, weekIsDeload });
}

describe("rir", () => {
  it("main lifts 1-2", () => {
    for (const s of ["pull_up", "overhead_press", "bench_press", "squat", "romanian_deadlift"]) {
      expect(rir([s])).toEqual({ rir_min: 1, rir_max: 2 });
    }
    expect(rir(["squat", "hack_squat"])).toEqual({ rir_min: 1, rir_max: 2 });
  });
  it("other weighted 1-3", () => {
    expect(rir(["lat_pulldown"])).toEqual({ rir_min: 1, rir_max: 3 });
    expect(rir(["bulgarian_split_squat"])).toEqual({ rir_min: 1, rir_max: 3 });
  });
  it("deload week, easy, light and deload modifier 3-4", () => {
    expect(rir(["squat"], [], true)).toEqual({ rir_min: 3, rir_max: 4 });
    expect(rir(["squat"], ["easy"])).toEqual({ rir_min: 3, rir_max: 4 });
    expect(rir(["bench_press"], ["light"])).toEqual({ rir_min: 3, rir_max: 4 });
    expect(rir(["pull_up"], ["deload"])).toEqual({ rir_min: 3, rir_max: 4 });
  });
  it("test 0-1 beats everything", () => {
    expect(rir(["pull_up"], ["test", "easy"], true)).toEqual({ rir_min: 0, rir_max: 1 });
  });
  it("non-load types null", () => {
    expect(rir(["hspu"])).toEqual({ rir_min: null, rir_max: null });
    expect(rir(["hanging_leg_raise"], ["easy"])).toEqual({ rir_min: null, rir_max: null });
    expect(rir(["bike_hiit"])).toEqual({ rir_min: null, rir_max: null });
  });
  it("one load option is enough (easy pull-down / hang)", () => {
    expect(rir(["lat_pulldown", "dead_hang"], ["easy"])).toEqual({ rir_min: 3, rir_max: 4 });
  });
});

describe("fallback", () => {
  it("pull-up only", () => {
    expect(fallbackFor(["pull_up"])).toEqual({
      if_bw_max_gte: 4,
      // biome-ignore lint/suspicious/noThenProperty: field name is part of the FallbackPrescription contract
      then: { sets: 4, reps_min: 4, reps_max: 6, mode: "bodyweight" },
      else: { sets: 4, reps_min: 6, reps_max: 6, mode: "assisted" },
    });
    expect(fallbackFor(["bench_press"])).toBeNull();
  });
});

describe("hspu prefix", () => {
  it("maps ladder prefixes", () => {
    expect(matchHspuPrefix("Feet-elevated pike push-up 4 × 6")).toMatchObject({
      kind: "step",
      step: "feet_elevated_pike",
    });
    expect(matchHspuPrefix("HSPU negative 3 × 3")).toMatchObject({ step: "hspu_negative" });
    expect(matchHspuPrefix("Partial-ROM wall HSPU 4 × 3")).toMatchObject({
      step: "partial_rom_wall_hspu",
    });
  });
  it("state prefixes have no step", () => {
    for (const t of [
      "Lower pad / harder progression 4 × 3",
      "Hardest clean progression 5 × 2–4",
      "current progression 2 × 3",
    ]) {
      expect(matchHspuPrefix(t)?.kind).toBe("state");
    }
    expect(matchHspuPrefix("4 × 3")).toBeNull();
  });
});
