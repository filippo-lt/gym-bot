import { describe, expect, it } from "vitest";
import { planSession } from "../../src/progression/engine.js";
import type { ExerciseInfo, SessionInput } from "../../src/progression/types.js";
import { barbell, pullup, session, set, stack, target } from "./helpers-load.js";

const SQUAT = barbell(1);
const PULLUP = pullup(4, { stepKg: 1.25, bands: { red: 10, black: 20 } });
const ROW = stack(3);
const HSPU: ExerciseInfo = {
  id: 5,
  slug: "hspu",
  type: "skill_ladder",
  loadBasis: null,
  isMainLift: false,
  equipment: null,
};
const HIIT: ExerciseInfo = {
  id: 6,
  slug: "hiit",
  type: "hiit",
  loadBasis: null,
  isMainLift: false,
  equipment: null,
};

function input(p: Partial<SessionInput> = {}): SessionInput {
  return {
    date: "2026-10-26",
    weekday: "mon",
    week: 5,
    isDeload: false,
    isTest: false,
    items: [],
    history: {},
    exercises: { 1: SQUAT, 3: ROW, 4: PULLUP, 5: HSPU, 6: HIIT },
    bodyweight: { kg: 80, date: "2026-10-20" },
    gateEvents: [],
    hspuLadder: [],
    heavyGroups: [],
    classReported: true,
    readinessSignals: [],
    frozenLevel: null,
    short: false,
    lastTrainingDate: "2026-10-23",
    occurrences: [],
    ...p,
  };
}

const squatSessions = [
  session(1, { date: "2026-10-19", sets: [set({ reps: 5, loadKg: 100, rir: 2 })] }),
  session(1, { date: "2026-10-12", sets: [set({ reps: 5, loadKg: 100, rir: 2 })] }),
  session(1, { date: "2026-10-05", sets: [set({ reps: 5, loadKg: 100, rir: 2 })] }),
];

describe("planSession", () => {
  it("main lift: load for reps_min at mid RIR, rounded toward easier", () => {
    const t = target({ plannedItemId: 1, exerciseIds: [1], repsMin: 5, rirMin: 1, rirMax: 2 });
    const r = planSession(input({ items: [t], history: { 1: squatSessions } }));
    const s = r.items[0]?.suggestion;
    // e1RM = 100 * (1 + 7/30) = 123.33; load = e1RM / (1 + 6.5/30) = 101.37 -> 100
    expect(s?.loadKg).toBe(100);
    expect(s?.labels).toEqual([]);
    expect(s?.rirMid).toBe(1.5);
  });

  it("no valid session: asks for the load", () => {
    const r = planSession(input({ items: [target()] }));
    expect(r.items[0]?.suggestion).toMatchObject({ ask: "load", labels: ["baseline_ask_load"] });
  });

  it("imported-only history is labelled check-first-set; one bot session is an estimate", () => {
    const imp = [session(1, { source: "import", sets: [set({ reps: 5, loadKg: 100, rir: 2 })] })];
    const r1 = planSession(input({ items: [target()], history: { 1: imp } }));
    expect(r1.items[0]?.suggestion?.labels).toEqual(["estimate_check_first_set"]);
    const one = [squatSessions[0] as (typeof squatSessions)[number]];
    const r2 = planSession(input({ items: [target()], history: { 1: one } }));
    expect(r2.items[0]?.suggestion?.labels).toEqual(["estimate"]);
  });

  it("break rule cuts 10% and labels it", () => {
    const r = planSession(
      input({
        items: [target()],
        history: { 1: squatSessions },
        occurrences: [
          {
            plannedItemId: 1,
            occurrences: [
              { date: "2026-10-12", logged: false },
              { date: "2026-10-19", logged: false },
            ],
          },
        ],
      }),
    );
    expect(r.items[0]?.suggestion?.labels).toContain("back_after_break");
    expect(r.items[0]?.suggestion?.loadKg).toBe(90);
  });

  it("accessory: +1 step when all sets hit reps_max, hold in a deload", () => {
    const hist = [
      session(3, {
        sets: [set({ reps: 12, loadKg: 40, rir: 2 }), set({ reps: 12, loadKg: 40, rir: 2 })],
      }),
    ];
    const t = target({ exerciseIds: [3], repsMin: 8, repsMax: 12, rirMin: 1, rirMax: 3 });
    const up = planSession(input({ items: [t], history: { 3: hist } }));
    expect(up.items[0]?.suggestion?.loadKg).toBe(45);
    const hold = planSession(
      input({ items: [{ ...t, isDeload: true }], isDeload: true, history: { 3: hist } }),
    );
    expect(hold.items[0]?.suggestion?.loadKg).toBe(40);
  });

  it("closed gate without a max: max test first, assisted fallback, both outcomes exposed", () => {
    const t = target({
      exerciseIds: [4],
      setsMin: 4,
      setsMax: 4,
      repsMin: 3,
      repsMax: 3,
      fallback: {
        if_bw_max_gte: 4,
        // biome-ignore lint/suspicious/noThenProperty: FallbackPrescription contract field
        then: { mode: "bodyweight", sets: 4, reps_min: 4, reps_max: 6 },
        else: { mode: "assisted", sets: 4, reps_min: 6, reps_max: 6 },
      },
    });
    const r = planSession(input({ items: [t] }));
    const item = r.items[0];
    expect(item?.pullup?.maxTestFirst).toBe(true);
    expect(item?.pullup?.afterMaxTest).toMatchObject({
      thresholdReps: 4,
      bw: { repsMin: 4, repsMax: 6 },
      assisted: { repsMin: 6, repsMax: 6 },
    });
    expect(item?.suggestion?.labels).toEqual(
      expect.arrayContaining(["fallback_assisted", "max_test_first"]),
    );
  });

  it("open gate: pull-up added weight, plain bodyweight when the need is below bodyweight", () => {
    const t = target({ exerciseIds: [4], repsMin: 3, repsMax: 3, rirMin: 1, rirMax: 2 });
    const hist = [
      session(4, {
        sets: [set({ reps: 6, rir: 2, clean: true, loadKg: null, addedKg: 0 })],
      }),
    ];
    const r = planSession(
      input({
        items: [t],
        history: { 4: hist },
        gateEvents: [{ kind: "clean_bw_set", date: "2026-10-05", reps: 6 }],
      }),
    );
    expect(r.items[0]?.pullup?.mode).toBe("weighted");
    const s = r.items[0]?.suggestion;
    expect(s?.addedKg).toBeGreaterThanOrEqual(0);
    expect(s?.assistKg).toBeUndefined();
  });

  it("stale bodyweight: label, needsBodyweight, still a suggestion", () => {
    const t = target({ exerciseIds: [4], repsMin: 3, repsMax: 3 });
    const hist = [session(4, { sets: [set({ reps: 6, rir: 2, clean: true, addedKg: 10 })] })];
    const r = planSession(
      input({
        items: [t],
        history: { 4: hist },
        gateEvents: [{ kind: "clean_bw_set", date: "2026-10-05", reps: 6 }],
        bodyweight: { kg: 80, date: "2026-09-01" },
      }),
    );
    expect(r.needsBodyweight).toBe(true);
    expect(r.items[0]?.suggestion?.labels).toContain("bw_stale");
    expect(r.items[0]?.suggestion?.ask).toBeUndefined();
    const none = planSession(input({ items: [t], history: { 4: hist }, bodyweight: null }));
    expect(none.items[0]?.suggestion?.ask).toBe("bodyweight");
  });

  it("test week: no load math, no suggestions", () => {
    const r = planSession(
      input({ isTest: true, items: [target()], history: { 1: squatSessions } }),
    );
    expect(r.isTest).toBe(true);
    expect(r.items[0]?.suggestion).toBeNull();
  });

  it("Friday: Thursday not reported asks first; heavy legs reduces the squat to 2 x reps_min at RIR 3-4", () => {
    const t = target({ tags: ["squat"], priority: "PRIMARY", repsMin: 4, repsMax: 4 });
    const asks = planSession(
      input({ weekday: "fri", classReported: false, items: [t], history: { 1: squatSessions } }),
    );
    expect(asks.askClassFirst).toBe(true);
    expect(asks.items[0]?.friday).toBeNull();
    const r = planSession(
      input({
        weekday: "fri",
        heavyGroups: ["legs"],
        items: [t],
        history: { 1: squatSessions },
      }),
    );
    const s = r.items[0]?.suggestion;
    expect(r.items[0]?.friday?.kind).toBe("reduce");
    expect(s).toMatchObject({ sets: 2, repsMin: 4, rirMin: 3, rirMax: 4, rirMid: 3.5 });
    expect(s?.labels).toContain("friday_reduced");
    expect(r.items[0]?.skipOffer).toBe(true);
  });

  it("YELLOW: Low items hidden, HIIT halved, main lifts at RIR 2.5 (lighter)", () => {
    const main = target({ plannedItemId: 1, tags: ["squat"], priority: "PRIMARY" });
    const low = target({ plannedItemId: 2, exerciseIds: [3], priority: "Low", planName: "low" });
    const hiit = target({
      plannedItemId: 3,
      exerciseIds: [6],
      tags: ["hiit"],
      priority: "PRIMARY",
      hiit: { rounds: 8, work_s: 30, rest_s: 30 },
    });
    const base = input({ items: [main, low, hiit], history: { 1: squatSessions } });
    const green = planSession(base);
    const yellow = planSession({ ...base, frozenLevel: "YELLOW" });
    expect(yellow.level).toBe("YELLOW");
    expect(yellow.items[1]?.hidden).toBe(true);
    expect(yellow.items[2]?.hiit?.rounds).toBe(4);
    expect(yellow.items[0]?.suggestion?.rirMid).toBe(2.5);
    expect(yellow.items[0]?.suggestion?.labels).toContain("readiness_yellow");
    expect(yellow.items[0]?.suggestion?.loadKg as number).toBeLessThanOrEqual(
      green.items[0]?.suggestion?.loadKg as number,
    );
  });

  it("RED: HIIT removed, pull-up kept as 2 easy sets; Friday with nothing left suggests rest", () => {
    const hiit = target({
      plannedItemId: 3,
      exerciseIds: [6],
      tags: ["hiit"],
      priority: "PRIMARY",
      hiit: { rounds: 8, work_s: 30, rest_s: 30 },
    });
    const pu = target({
      plannedItemId: 4,
      exerciseIds: [4],
      tags: ["skill_strength"],
      repsMin: 3,
      repsMax: 3,
    });
    const r = planSession(
      input({
        weekday: "wed",
        items: [hiit, pu],
        frozenLevel: "RED",
        gateEvents: [{ kind: "clean_bw_set", date: "2026-10-05", reps: 6 }],
        history: { 4: [session(4, { sets: [set({ reps: 6, rir: 2, clean: true, addedKg: 5 })] })] },
      }),
    );
    expect(r.items[0]?.hidden).toBe(true);
    expect(r.items[0]?.hiit).toBeNull();
    expect(r.items[1]?.hidden).toBe(false);
    expect(r.items[1]?.prescription).toMatchObject({ sets: 2, rirMin: 3, rirMax: 4 });

    const fri = planSession(
      input({
        weekday: "fri",
        items: [target({ tags: ["squat"], priority: "PRIMARY" })],
        frozenLevel: "RED",
      }),
    );
    expect(fri.restDaySuggested).toBe(true);
    expect(planSession(input({ weekday: "thu", frozenLevel: "RED" })).classAdvice).toBe(true);
  });

  it("short: Low hidden, Medium optional", () => {
    const low = target({ plannedItemId: 1, priority: "Low" });
    const med = target({ plannedItemId: 2, priority: "Medium" });
    const r = planSession(input({ items: [low, med], short: true }));
    expect(r.items[0]?.hidden).toBe(true);
    expect(r.items[1]?.optional).toBe(true);
    expect(r.items[1]?.hidden).toBe(false);
  });

  it("OR item: each option gets its own suggestion from its own history", () => {
    const hack = { ...barbell(2), slug: "hack_squat", loadBasis: "stack" as const };
    const t = target({ exerciseIds: [1, 2] });
    const r = planSession(
      input({
        items: [t],
        exercises: { 1: SQUAT, 2: hack as ExerciseInfo },
        history: { 1: squatSessions },
      }),
    );
    expect(r.items[0]?.suggestions[1]?.loadKg).toBe(100);
    expect(r.items[0]?.suggestions[2]?.ask).toBe("load");
  });
});
