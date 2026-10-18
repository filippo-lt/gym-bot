import { describe, expect, it } from "vitest";
import {
  buildEntries,
  expandSets,
  maxReps,
  missingFields,
  systemLoad,
  type UnitExercise,
} from "../../src/logging/units.js";

const barbell: UnitExercise = {
  type: "weighted",
  loadBasis: "barbell_total",
  equipment: { slug: "barbell", baseKg: 15, stepKg: 2.5, discreteValues: null },
};
const dumbbell: UnitExercise = {
  type: "weighted",
  loadBasis: "per_hand",
  equipment: { slug: "dumbbells", baseKg: null, stepKg: 2.5, discreteValues: null },
};
const stack: UnitExercise = {
  type: "weighted",
  loadBasis: "stack",
  equipment: { slug: "cable_stack", baseKg: null, stepKg: 2.5, discreteValues: null },
};
const pullUp: UnitExercise = {
  type: "bodyweight_plus",
  loadBasis: "bodyweight_plus",
  equipment: null,
};

describe("expandSets", () => {
  it("expands a uniform block into independent sets", () => {
    const sets = expandSets({ count: 3, reps: 8, load_kg: 60 });
    expect(sets).toEqual([
      { reps: 8, load_kg: 60 },
      { reps: 8, load_kg: 60 },
      { reps: 8, load_kg: 60 },
    ]);
    expect(sets[0]).not.toBe(sets[1]);
  });
  it("passes arrays through", () => {
    const arr = [{ reps: 5 }, { reps: 4 }];
    expect(expandSets(arr)).toBe(arr);
  });
});

describe("buildEntries", () => {
  it("numbers sets from 1", () => {
    const e = buildEntries(barbell, { count: 3, reps: 8, load_kg: 60 });
    expect(e.map((x) => x.setIndex)).toEqual([1, 2, 3]);
    expect(e.every((x) => x.loadKg === 60 && x.reps === 8)).toBe(true);
  });

  it("adds the bar to plates per side", () => {
    const e = buildEntries(barbell, [{ reps: 5, plates_per_side_kg: 20 }]);
    expect(e[0]?.loadKg).toBe(55);
  });

  it("keeps a barbell total as said", () => {
    expect(buildEntries(barbell, [{ reps: 5, load_kg: 57.5 }])[0]?.loadKg).toBe(57.5);
  });

  it("halves a dumbbell pair to per hand", () => {
    expect(buildEntries(dumbbell, [{ reps: 10, pair_total_kg: 24 }])[0]?.loadKg).toBe(12);
    expect(buildEntries(dumbbell, [{ reps: 10, load_kg: 12 }])[0]?.loadKg).toBe(12);
  });

  it("keeps a stack value", () => {
    expect(buildEntries(stack, [{ reps: 15, load_kg: 20 }])[0]?.loadKg).toBe(20);
  });

  it("splits pull-up added and assist", () => {
    const [added] = buildEntries(pullUp, [{ reps: 5, added_kg: 10 }]);
    expect(added).toMatchObject({ addedKg: 10, assistKg: 0, loadKg: null });
    const [assisted] = buildEntries(pullUp, [{ reps: 5, assist_kg: 20 }]);
    expect(assisted).toMatchObject({ addedKg: 0, assistKg: 20 });
    const [bare] = buildEntries(pullUp, [{ reps: 5 }]);
    expect(bare).toMatchObject({ addedKg: 0, assistKg: 0 });
    const [viaLoad] = buildEntries(pullUp, [{ reps: 5, load_kg: 7.5 }]);
    expect(viaLoad?.addedKg).toBe(7.5);
  });

  it("stores an unmapped band as a colour with no assistance kg", () => {
    const [e] = buildEntries(pullUp, [{ reps: 5, band: "Red band" }]);
    expect(e).toMatchObject({ band: "red", note: null, addedKg: 0, assistKg: null });
  });

  it("takes the assistance kg of a mapped band from the equipment", () => {
    const mapped: UnitExercise = {
      ...pullUp,
      equipment: {
        slug: "pullup",
        baseKg: null,
        stepKg: 2.5,
        discreteValues: null,
        bands: { red: 15 },
      },
    };
    const [e] = buildEntries(mapped, [{ reps: 5, band: "red" }]);
    expect(e).toMatchObject({ band: "red", assistKg: 15 });
    // an explicit assist_kg wins over the mapping
    const [explicit] = buildEntries(mapped, [{ reps: 5, band: "red", assist_kg: 20 }]);
    expect(explicit?.assistKg).toBe(20);
  });

  it("has no system load for a band set without a kg mapping", () => {
    const [e] = buildEntries(pullUp, [{ reps: 5, band: "red" }]);
    expect(e && systemLoad(e, pullUp, 80)).toBeNull();
    const [plain] = buildEntries(pullUp, [{ reps: 5, assist_kg: 20 }]);
    expect(plain && systemLoad(plain, pullUp, 80)).toBe(60);
  });

  it("puts the group RIR on the last set only", () => {
    const e = buildEntries(barbell, { count: 3, reps: 8, load_kg: 60 }, { rir: 2 });
    expect(e.map((x) => x.rir)).toEqual([null, null, 2]);
  });

  it("maps '4+' to RIR 4 with plus on the last set", () => {
    const e = buildEntries(barbell, { count: 2, reps: 8, load_kg: 60 }, { rir: "4+" });
    expect(e.map((x) => [x.rir, x.rirPlus])).toEqual([
      [null, false],
      [4, true],
    ]);
  });

  it("keeps the last set's own RIR over the group RIR", () => {
    const e = buildEntries(
      barbell,
      [
        { reps: 8, load_kg: 60 },
        { reps: 8, load_kg: 60, rir: 1 },
      ],
      {
        rir: 3,
      },
    );
    expect(e.map((x) => x.rir)).toEqual([null, 1]);
  });

  it("applies group clean to every set", () => {
    const e = buildEntries(pullUp, { count: 3, reps: 5 }, { clean: false });
    expect(e.every((x) => x.clean === false)).toBe(true);
    expect(buildEntries(pullUp, [{ reps: 5 }])[0]?.clean).toBeNull();
  });
});

describe("systemLoad", () => {
  it("uses the load for weighted exercises", () => {
    expect(systemLoad({ loadKg: 60, addedKg: null, assistKg: null }, barbell, 70)).toBe(60);
  });
  it("is bw + added - assist for pull-ups", () => {
    expect(systemLoad({ loadKg: null, addedKg: 10, assistKg: 0 }, pullUp, 70)).toBe(80);
    expect(systemLoad({ loadKg: null, addedKg: 0, assistKg: 20 }, pullUp, 70)).toBe(50);
  });
  it("is null without bodyweight or for other types", () => {
    expect(systemLoad({ loadKg: null, addedKg: 10, assistKg: 0 }, pullUp, null)).toBeNull();
    expect(
      systemLoad({ loadKg: 5, addedKg: null, assistKg: null }, { type: "bodyweight_reps" }, 70),
    ).toBeNull();
  });
});

describe("missingFields / maxReps", () => {
  it("asks for reps and load on weighted", () => {
    expect(missingFields(barbell, buildEntries(barbell, [{}]))).toEqual(["reps", "load"]);
    expect(missingFields(barbell, buildEntries(barbell, [{ reps: 5, load_kg: 60 }]))).toEqual([]);
  });
  it("needs duration for timed and nothing for mobility", () => {
    const timed: UnitExercise = { type: "timed", loadBasis: null, equipment: null };
    expect(missingFields(timed, buildEntries(timed, [{}]))).toEqual(["duration"]);
    const mob: UnitExercise = { type: "mobility", loadBasis: null, equipment: null };
    expect(missingFields(mob, buildEntries(mob, [{}]))).toEqual([]);
  });
  it("needs reps for pull-ups but not a load", () => {
    expect(missingFields(pullUp, buildEntries(pullUp, [{}]))).toEqual(["reps"]);
  });
  it("finds the best reps", () => {
    expect(maxReps(buildEntries(barbell, [{ reps: 5 }, { reps: 8 }, {}]))).toBe(8);
  });
});
