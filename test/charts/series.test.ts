import { describe, expect, it } from "vitest";
import {
  chartKindFor,
  loadSeries,
  repsSeries,
  VOLUME_TYPES,
  volumeSeries,
} from "../../src/charts/series";
import { setE1rm } from "../../src/progression/e1rm";
import type { ExerciseInfo, SessionRec, SetRec } from "../../src/progression/types";

const set = (o: Partial<SetRec> = {}): SetRec => ({
  reps: null,
  loadKg: null,
  addedKg: null,
  assistKg: null,
  band: null,
  rir: null,
  rirPlus: false,
  clean: null,
  durationS: null,
  ...o,
});

const session = (o: Partial<SessionRec> = {}): SessionRec => ({
  date: "2026-09-28",
  exerciseId: 1,
  plannedItemIds: [],
  source: "bot",
  bwKg: null,
  week: 1,
  isDeload: false,
  isTest: false,
  readiness: "GREEN",
  perSetUnknown: false,
  hspuStepOrder: null,
  padHeight: null,
  suggestion: null,
  sets: [],
  ...o,
});

const info = (o: Partial<ExerciseInfo> = {}): ExerciseInfo => ({
  id: 1,
  slug: "squat",
  type: "weighted",
  loadBasis: "barbell_total",
  isMainLift: true,
  equipment: null,
  ...o,
});

const pullup = info({
  id: 2,
  slug: "pull_up",
  type: "bodyweight_plus",
  loadBasis: "bodyweight_plus",
});

describe("loadSeries", () => {
  it("uses only sets with RIR", () => {
    const s = session({
      sets: [set({ reps: 5, rir: 2, loadKg: 80 }), set({ reps: 5, rir: null, loadKg: 85 })],
    });
    const [p] = loadSeries([s], info());
    expect(p?.e1rm).toBeCloseTo(setE1rm(80, 5, 2));
    expect(p?.flagged).toBe(false);
    expect(p?.estimate).toBe(false);
  });

  it("flags deload without an e1RM point", () => {
    const s = session({ isDeload: true, sets: [set({ reps: 5, rir: 2, loadKg: 80 })] });
    expect(loadSeries([s], info())[0]).toMatchObject({ flagged: true, e1rm: null });
  });

  it("flags test weeks", () => {
    const s = session({ isTest: true, sets: [set({ reps: 5, rir: 2, loadKg: 80 })] });
    expect(loadSeries([s], info())[0]).toMatchObject({ flagged: true, e1rm: null });
  });

  it("marks import sessions as estimates", () => {
    const s = session({ source: "import", sets: [set({ reps: 5, rir: 2, loadKg: 80 })] });
    expect(loadSeries([s], info())[0]?.estimate).toBe(true);
  });

  it("gives RED sessions no e1RM", () => {
    const s = session({ readiness: "RED", sets: [set({ reps: 5, rir: 2, loadKg: 80 })] });
    expect(loadSeries([s], info())[0]?.e1rm).toBeNull();
  });

  it("gives perSetUnknown sessions no e1RM", () => {
    const s = session({ perSetUnknown: true, sets: [set({ reps: 18, rir: 4, loadKg: 60 })] });
    expect(loadSeries([s], info())[0]?.e1rm).toBeNull();
  });

  it("lets a 4+ set raise but not lower the estimate", () => {
    const strict = setE1rm(80, 5, 2);
    const plus = setE1rm(80, 8, 4);
    const s = session({
      sets: [
        set({ reps: 5, rir: 2, loadKg: 80 }),
        set({ reps: 8, rir: 4, rirPlus: true, loadKg: 80 }),
      ],
    });
    expect(loadSeries([s], info())[0]?.e1rm).toBeCloseTo(Math.max(strict, plus));
    const low = session({
      sets: [
        set({ reps: 5, rir: 2, loadKg: 80 }),
        set({ reps: 1, rir: 4, rirPlus: true, loadKg: 80 }),
      ],
    });
    expect(loadSeries([low], info())[0]?.e1rm).toBeCloseTo(strict);
  });

  it("returns oldest first", () => {
    const newer = session({ date: "2026-10-05", sets: [set({ reps: 5, rir: 2, loadKg: 82 })] });
    const older = session({ date: "2026-09-28", sets: [set({ reps: 5, rir: 2, loadKg: 80 })] });
    expect(loadSeries([newer, older], info()).map((p) => p.date)).toEqual([
      "2026-09-28",
      "2026-10-05",
    ]);
  });

  it("pull-up without bodyweight has no e1RM but keeps reps", () => {
    const s = session({
      exerciseId: 2,
      bwKg: null,
      sets: [set({ reps: 6, rir: 1, addedKg: 0 }), set({ reps: 8, rir: 1, addedKg: 0 })],
    });
    expect(loadSeries([s], pullup)[0]?.e1rm).toBeNull();
    expect(repsSeries([s], pullup)[0]?.bestSet).toBe(8);
  });

  it("pull-up e1RM uses system load", () => {
    const s = session({
      exerciseId: 2,
      bwKg: 80,
      sets: [set({ reps: 5, rir: 1, addedKg: 10 })],
    });
    expect(loadSeries([s], pullup)[0]?.e1rm).toBeCloseTo(setE1rm(90, 5, 1));
  });
});

describe("repsSeries", () => {
  it("takes the most reps in one set, oldest first", () => {
    const ex = info({ type: "bodyweight_reps", loadBasis: null });
    const a = session({ date: "2026-10-05", sets: [set({ reps: 12 }), set({ reps: 15 })] });
    const b = session({ date: "2026-09-28", sets: [set({ reps: 10 })], isDeload: true });
    const out = repsSeries([a, b], ex);
    expect(out.map((p) => [p.date, p.bestSet, p.flagged])).toEqual([
      ["2026-09-28", 10, true],
      ["2026-10-05", 15, false],
    ]);
  });

  it("carries the HSPU step name", () => {
    const ex = info({ type: "skill_ladder", loadBasis: null });
    const s = session({ hspuStepOrder: 2, sets: [set({ reps: 3 })] });
    const names = new Map([
      [1, "Negative"],
      [2, "Wall"],
    ]);
    expect(repsSeries([s], ex, names)[0]?.step).toBe("Wall");
    expect(repsSeries([s], ex)[0]?.step).toBeNull();
  });

  it("uses the longest hold for timed", () => {
    const ex = info({ type: "timed", loadBasis: null });
    const s = session({ sets: [set({ durationS: 30 }), set({ durationS: 45 })] });
    expect(repsSeries([s], ex)[0]).toMatchObject({ seconds: 45, bestSet: null });
  });

  it("skips perSetUnknown sessions", () => {
    const ex = info({ type: "bodyweight_reps", loadBasis: null });
    expect(repsSeries([session({ perSetUnknown: true, sets: [set({ reps: 17 })] })], ex)).toEqual(
      [],
    );
  });

  it("ignores unclean sets for the best set", () => {
    const ex = info({ type: "bodyweight_reps", loadBasis: null });
    const s = session({ sets: [set({ reps: 10, clean: false }), set({ reps: 7, clean: true })] });
    expect(repsSeries([s], ex)[0]?.bestSet).toBe(7);
  });

  it("drops sessions without data", () => {
    const ex = info({ type: "skill_ladder", loadBasis: null });
    expect(repsSeries([session({ hspuStepOrder: 2, sets: [] })], ex)).toEqual([]);
  });
});

describe("volumeSeries", () => {
  it("sums hard sets per week and muscle group, ignoring non-volume types and out-of-plan rows", () => {
    const out = volumeSeries(
      [
        { week: 1, muscleGroup: "quads", type: "weighted", sets: 3 },
        { week: 1, muscleGroup: "quads", type: "weighted", sets: 2 },
        { week: 1, muscleGroup: "back", type: "bodyweight_plus", sets: 4 },
        { week: 2, muscleGroup: "quads", type: "weighted", sets: 1 },
        { week: 1, muscleGroup: "core", type: "mobility", sets: 5 },
        { week: 1, muscleGroup: "core", type: "hiit", sets: 5 },
        { week: 1, muscleGroup: "core", type: "timed", sets: 5 },
        { week: null, muscleGroup: "quads", type: "weighted", sets: 9 },
        { week: 4, muscleGroup: "quads", type: "weighted", sets: 9 },
      ],
      3,
    );
    expect(out).toEqual([
      { week: 1, muscleGroup: "back", sets: 4 },
      { week: 1, muscleGroup: "quads", sets: 5 },
      { week: 2, muscleGroup: "quads", sets: 1 },
    ]);
  });

  it("exposes the counted types", () => {
    expect([...VOLUME_TYPES]).toEqual([
      "weighted",
      "bodyweight_plus",
      "bodyweight_reps",
      "skill_ladder",
    ]);
  });
});

describe("chartKindFor", () => {
  it("maps every type", () => {
    expect(chartKindFor("weighted")).toBe("load");
    expect(chartKindFor("bodyweight_plus")).toBe("load_reps");
    expect(chartKindFor("bodyweight_reps")).toBe("reps");
    expect(chartKindFor("skill_ladder")).toBe("hspu");
    expect(chartKindFor("timed")).toBe("timed");
    expect(chartKindFor("distance")).toBe("none");
    expect(chartKindFor("skill_practice")).toBe("none");
    expect(chartKindFor("hiit")).toBe("none");
    expect(chartKindFor("mobility")).toBe("none");
  });
});
