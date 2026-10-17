import { describe, expect, it } from "vitest";
import { parsePrescription } from "../../src/plan-import/parse-prescription.js";
import type { ExerciseType } from "../../src/plan-import/types.js";

const W: ExerciseType[] = ["weighted"];
const BW: ExerciseType[] = ["bodyweight_plus"];
const H: ExerciseType[] = ["skill_ladder"];

function p(raw: string, types: ExerciseType[] = W) {
  return parsePrescription(raw, { types });
}
const codes = (r: ReturnType<typeof p>) => r.flags.map((f) => f.code);

describe("sets x reps", () => {
  it("4 × 3", () => {
    const r = p("4 × 3");
    expect([r.sets_min, r.sets_max, r.reps_min, r.reps_max]).toEqual([4, 4, 3, 3]);
    expect(r.flags).toEqual([]);
  });
  it("range on both sides", () => {
    const r = p("2–3 × 5–8");
    expect([r.sets_min, r.sets_max, r.reps_min, r.reps_max]).toEqual([2, 3, 5, 8]);
  });
  it("accepts x and hyphen", () => {
    const r = p("2-3 x 5-8");
    expect([r.sets_min, r.sets_max, r.reps_min, r.reps_max]).toEqual([2, 3, 5, 8]);
    const r2 = p("4x3");
    expect([r2.sets_min, r2.reps_min]).toEqual([4, 3]);
  });
  it("/leg sets per_side", () => {
    const r = p("2 × 8/leg");
    expect([r.sets_min, r.reps_min, r.per_side]).toEqual([2, 8, true]);
    expect(r.flags).toEqual([]);
  });
  it("/leg with easy", () => {
    const r = p("1 × 8/leg easy");
    expect(r.per_side).toBe(true);
    expect(r.modifiers).toEqual(["easy"]);
  });
});

describe("extras and modifiers", () => {
  it("+ 1 easy BW set becomes an extra", () => {
    const r = p("3 × 2–3 + 1 easy BW set", BW);
    expect([r.sets_min, r.reps_min, r.reps_max]).toEqual([3, 2, 3]);
    expect(r.modifiers).toEqual([]);
    expect(r.extras_raw).toBe("+ 1 easy BW set");
    expect(r.extras).toEqual([
      {
        raw: "+ 1 easy BW set",
        sets: 1,
        modifiers: ["easy"],
        flags: [{ code: "missing_reps", detail: expect.any(String) }],
      },
    ]);
    expect(r.flags).toEqual([]);
  });
  it("stop before form breaks", () => {
    const r = p("4 × 5 (or stop 1 rep before form breaks)", BW);
    expect([r.sets_min, r.reps_min]).toEqual([4, 5]);
    expect(r.modifiers).toEqual(["stop_before_form_breaks"]);
    expect(r.flags).toEqual([]);
  });
  it("easy", () => expect(p("2 × 8 easy").modifiers).toEqual(["easy"]));
  it("light", () => expect(p("2 × 6 light").modifiers).toEqual(["light"]));
  it("heavy-clean", () => expect(p("4 × 3 heavy-clean", BW).modifiers).toEqual(["heavy_clean"]));
  it("slightly heavier", () => {
    const r = p("4 × 2–3 slightly heavier", BW);
    expect(r.modifiers).toEqual(["slightly_heavier"]);
    expect(r.flags).toEqual([]);
  });
  it("leading Optional", () => {
    const r = p("Optional 1 × 12–15");
    expect(r.modifiers).toEqual(["optional"]);
    expect([r.sets_min, r.reps_min, r.reps_max]).toEqual([1, 12, 15]);
  });
  it("leading Deload:", () => {
    expect(p("Deload: 2 × 3").modifiers).toEqual(["deload"]);
  });
  it("OHP or bench prefix gives options", () => {
    const r = p("OHP or bench: 2 × 5 easy");
    expect(r.options_from_text).toEqual(["overhead_press", "bench_press"]);
    expect([r.sets_min, r.reps_min]).toEqual([2, 5]);
    expect(r.modifiers).toEqual(["easy"]);
    expect(r.flags).toEqual([]);
  });
});

describe("HSPU", () => {
  it("feet-elevated pike", () => {
    const r = p("Feet-elevated pike push-up 4 × 6", H);
    expect(r.hspu_step).toBe("feet_elevated_pike");
    expect([r.sets_min, r.reps_min]).toEqual([4, 6]);
    expect(r.flags).toEqual([]);
  });
  it("negative with tempo", () => {
    const r = p("HSPU negative 3 × 3, 5s down", H);
    expect(r.hspu_step).toBe("hspu_negative");
    expect(r.tempo).toBe("5s down");
    expect(r.flags).toEqual([]);
  });
  it("partial-ROM wall", () => {
    const r = p("Partial-ROM wall HSPU 4 × 3", H);
    expect(r.hspu_step).toBe("partial_rom_wall_hspu");
    expect(r.flags).toEqual([]);
  });
  it("Lower pad / harder progression is not an OR and has no step", () => {
    const r = p("Lower pad / harder progression 4 × 3", H);
    expect(r.hspu_step).toBeNull();
    expect([r.sets_min, r.reps_min]).toEqual([4, 3]);
    expect(codes(r)).toEqual(["hspu_step_from_state"]);
  });
  it("Hardest clean progression", () => {
    const r = p("Hardest clean progression 5 × 2–4", H);
    expect([r.sets_min, r.reps_min, r.reps_max]).toEqual([5, 2, 4]);
    expect(codes(r)).toEqual(["hspu_step_from_state"]);
  });
  it("Deload: current progression", () => {
    const r = p("Deload: current progression 2 × 3 easy", H);
    expect(r.modifiers).toEqual(["deload", "easy"]);
    expect([r.sets_min, r.reps_min]).toEqual([2, 3]);
    expect(codes(r)).toEqual(["hspu_step_from_state"]);
  });
  it("TEST row", () => {
    const r = p("TEST: 3–5 serious attempts; record reps + ROM / pad height", H);
    expect(r.modifiers).toEqual(["test", "max_attempts"]);
    expect([r.sets_min, r.sets_max]).toEqual([3, 5]);
    expect(codes(r)).toEqual(["hspu_step_from_state", "max_reps"]);
  });
});

describe("hiit and durations", () => {
  it("8 × 30s hard / 90s easy", () => {
    const r = p("8 × 30s hard / 90s easy", ["hiit"]);
    expect(r.hiit).toEqual({ rounds: 8, work_s: 30, rest_s: 90 });
    expect(r.sets_min).toBeNull();
    expect(r.modifiers).toEqual([]);
    expect(r.flags).toEqual([]);
  });
  it("5–7 min line/balance practice (slash is not an OR)", () => {
    const r = p("5–7 min line/balance practice", ["skill_practice"]);
    expect([r.duration_s_min, r.duration_s_max]).toEqual([300, 420]);
    expect(r.leftover).toBe("line/balance practice");
    expect(r.flags).toEqual([]);
  });
  it("4–5 min easy", () => {
    const r = p("4–5 min easy", ["warmup"]);
    expect([r.duration_s_min, r.duration_s_max]).toEqual([240, 300]);
    expect(r.modifiers).toEqual(["easy"]);
  });
  it("5 min progressive easy spin", () => {
    const r = p("5 min progressive easy spin", ["warmup"]);
    expect([r.duration_s_min, r.duration_s_max]).toEqual([300, 300]);
    expect(r.flags).toEqual([]);
  });
  it("20–30 min easy movement + mobility", () => {
    const r = p("20–30 min easy movement + mobility", ["recovery"]);
    expect([r.duration_s_min, r.duration_s_max]).toEqual([1200, 1800]);
    expect(r.flags).toEqual([]);
  });
});

describe("max attempts and flags", () => {
  it("3 max-clean attempts + optional triple", () => {
    const r = p("3 max-clean attempts; optional weighted top triple if fresh", BW);
    expect([r.sets_min, r.sets_max, r.reps_min]).toEqual([3, 3, null]);
    expect(r.modifiers).toEqual(["test", "max_attempts"]);
    expect(codes(r)).toEqual(["max_reps", "optional_extra"]);
    expect(r.modifiers).not.toContain("optional");
  });
  it("2 easy sets, then stop", () => {
    const r = p("2 easy sets, then stop", ["weighted", "timed"]);
    expect([r.sets_min, r.reps_min]).toEqual([2, null]);
    expect(r.modifiers).toEqual(["easy"]);
    expect(codes(r)).toEqual(["missing_reps"]);
  });
  it("leftover flagged for load-math types", () => {
    expect(codes(p("3 × 5 with pause"))).toEqual(["unparsed_text"]);
  });
  it("leftover fine for descriptive types", () => {
    expect(p("Easy class; no maximal work", ["class"]).flags).toEqual([]);
  });
  it("nothing parsed on a load type", () => {
    expect(codes(p("go heavy"))).toEqual(["unparsed_text", "missing_sets"]);
  });
  it("multi-move text stays raw with no flag", () => {
    const raw = "Dead hang 2×25s · scapular pull-up 2×8 · band straight-arm pulldown 1×15";
    const r = p(raw, ["warmup"]);
    expect(r.sets_min).toBeNull();
    expect(r.leftover).toBe(raw);
    expect(r.flags).toEqual([]);
  });
  it("slash in mobility text is not touched", () => {
    const r = p("Pike stretch 2×40s · couch stretch 60s/side", ["mobility"]);
    expect(r.per_side).toBe(false);
    expect(r.flags).toEqual([]);
  });
  it("class text", () => {
    const r = p("Record whether class was heavy on PULL / PUSH / LEGS", ["class"]);
    expect(r.flags).toEqual([]);
    expect(r.modifiers).toEqual([]);
  });
});
