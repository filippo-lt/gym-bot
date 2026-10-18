import { describe, expect, it } from "vitest";
import type { LoadPoint, RepsPoint, VolumeCell } from "../../src/charts/series";
import { axisUnit, exerciseSpec, volumeSpec } from "../../src/charts/spec";
import type { ExerciseInfo } from "../../src/progression/types";

const info = (o: Partial<ExerciseInfo> = {}): ExerciseInfo => ({
  id: 1,
  slug: "squat",
  type: "weighted",
  loadBasis: "barbell_total",
  isMainLift: true,
  equipment: null,
  ...o,
});

const load: LoadPoint[] = [
  { date: "2026-09-29", week: 1, e1rm: 85, flagged: false, estimate: false },
  { date: "2026-10-06", week: 2, e1rm: 90, flagged: false, estimate: true },
  { date: "2026-10-13", week: 3, e1rm: null, flagged: true, estimate: false },
];
const reps: RepsPoint[] = [
  { date: "2026-09-29", week: 1, bestSet: 6, seconds: null, step: null, flagged: false },
  { date: "2026-10-06", week: 2, bestSet: 8, seconds: null, step: null, flagged: false },
];

describe("axisUnit", () => {
  it("states the unit per load basis", () => {
    expect(axisUnit(info())).toBe("kg");
    expect(axisUnit(info({ loadBasis: "per_hand" }))).toBe("kg per hand");
    expect(axisUnit(info({ loadBasis: "stack" }))).toBe("kg (stack)");
    expect(axisUnit(info({ loadBasis: "bodyweight_plus", type: "bodyweight_plus" }))).toBe(
      "kg system load",
    );
  });
});

describe("exerciseSpec", () => {
  it("stacks two panels for pull-ups on auto", () => {
    const s = exerciseSpec(
      "Pull-up",
      info({ type: "bodyweight_plus" }),
      "load_reps",
      load,
      reps,
      "auto",
    );
    expect("vconcat" in s && s.vconcat.length).toBe(2);
  });

  it("is a single panel for load and reps kinds", () => {
    expect("vconcat" in exerciseSpec("Squat", info(), "load", load, reps, "auto")).toBe(false);
    expect("vconcat" in exerciseSpec("Chin", info(), "reps", load, reps, "auto")).toBe(false);
  });

  it("uses an ordinal x axis of formatted date strings", () => {
    const s = JSON.stringify(exerciseSpec("Squat", info(), "load", load, reps, "auto"));
    expect(s).toContain('"29 Sep"');
    expect(s).toContain('"type":"ordinal"');
    expect(s).toContain('"font":"Inter"');
  });

  it("shades flagged weeks and gives them no e1RM value", () => {
    const s = JSON.stringify(exerciseSpec("Squat", info(), "load", load, reps, "auto"));
    expect(s).toContain('"13 Oct"');
    expect(s).toContain('"rect"');
  });
});

describe("volumeSpec", () => {
  it("lists W1..W<current> on the x domain", () => {
    const cells: VolumeCell[] = [{ week: 2, muscleGroup: "quads", sets: 6 }];
    const s = JSON.stringify(volumeSpec(cells, 5));
    expect(s).toContain('["W1","W2","W3","W4","W5"]');
    expect(s).toContain('"stack"');
  });
});
