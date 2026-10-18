import { describe, expect, it } from "vitest";
import {
  decidePolicy,
  farOffLoadRef,
  isLoadFarOff,
  isRepsFarOff,
} from "../../src/logging/policy.js";
import type { StagedAction } from "../../src/logging/types.js";
import { editInput, entry, logAction, logInput, snapshot, squat } from "./helpers.js";

const reasons = (actions: StagedAction[]) => {
  const d = decidePolicy(actions);
  return d.mode === "confirm" ? d.reasons : d.mode;
};

describe("decidePolicy", () => {
  it("never writes directly while a request is open", () => {
    expect(decidePolicy([logAction()], { openPending: true })).toEqual({
      mode: "confirm",
      reasons: ["replaces_pending"],
    });
    expect(decidePolicy([logAction()], { openPending: false })).toEqual({ mode: "direct" });
  });

  it("writes a single clear log in today's session directly", () => {
    expect(decidePolicy([logAction()])).toEqual({ mode: "direct" });
  });

  it("does not ask for a missing RIR or clean", () => {
    const a = logAction({ entries: [entry({ rir: null, clean: null })] });
    expect(decidePolicy([a])).toEqual({ mode: "direct" });
  });

  it("confirms more than one write", () => {
    expect(reasons([logAction(), logAction()])).toEqual(["multiple_writes"]);
  });

  it("confirms an exercise outside today's session and a make-up", () => {
    expect(reasons([logAction({ match: "unplanned" })])).toEqual(["not_in_today"]);
    expect(reasons([logAction({ match: "makeup" })])).toEqual(["makeup"]);
  });

  it("confirms missing fields, guesses and the model flag", () => {
    expect(reasons([logAction({ missingFields: ["reps"] })])).toEqual(["missing_field"]);
    expect(reasons([logAction({ guessedFields: ["sets"] })])).toEqual(["guessed"]);
    expect(reasons([logAction({ needsConfirmation: true })])).toEqual(["model_flag"]);
  });

  it("confirms every delete", () => {
    expect(reasons([{ kind: "delete_group", snapshot: snapshot() }])).toEqual(["delete"]);
  });

  it("always confirms save_memory, alone or with other actions", () => {
    const mem: StagedAction = {
      kind: "save_memory",
      input: { kind: "limitation", content: "left shoulder sensitive on dips" },
    };
    expect(decidePolicy([mem])).toEqual({ mode: "confirm", reasons: ["memory"] });
    expect(reasons([mem, logAction()])).toEqual(["multiple_writes", "memory"]);
    expect(decidePolicy([mem], { openPending: true })).toEqual({
      mode: "confirm",
      reasons: ["replaces_pending", "memory"],
    });
  });

  it("collects several reasons without duplicates", () => {
    const a = logAction({ match: "unplanned", guessedFields: ["reps"] });
    expect(reasons([a, a])).toEqual(["multiple_writes", "not_in_today", "guessed"]);
  });

  it("asks which exercise before anything else, using the first clarify index", () => {
    const clarify: StagedAction = {
      kind: "clarify_exercise",
      input: logInput(),
      said: "fp",
      candidates: [],
    };
    expect(decidePolicy([logAction(), clarify, clarify])).toEqual({ mode: "clarify", index: 1 });
  });

  it("flags a far-off load and far-off reps on a log", () => {
    const heavy = logAction({ entries: [entry({ loadKg: 600 })] });
    expect(reasons([heavy])).toEqual(["load_far_off"]);
    const reps = logAction({ entries: [entry({ reps: 50 })] });
    expect(reasons([reps])).toEqual(["reps_far_off"]);
  });

  it("falls back to the plan's reps_max when there is no last session", () => {
    const item = {
      id: 1,
      subItem: 0,
      week: 1,
      weekday: "tue" as const,
      planName: "Squat",
      priority: "High" as const,
      setsMin: 3,
      setsMax: 3,
      repsMin: 6,
      repsMax: 8,
      rirMin: null,
      rirMax: null,
      isDeload: false,
    };
    const a = logAction({
      lastSession: null,
      plannedItem: item,
      entries: [entry({ reps: 16 })],
    });
    expect(reasons([a])).toEqual(["reps_far_off"]);
    expect(reasons([logAction({ lastSession: null, entries: [entry({ reps: 16 })] })])).toBe(
      "direct",
    );
  });

  it("checks edits against the after values", () => {
    const before = snapshot();
    const after = snapshot({
      entries: [entry({ setIndex: 1, loadKg: 600 }), entry({ setIndex: 2 })],
    });
    const edit: StagedAction = {
      kind: "edit_group",
      input: editInput({ load_kg: 600 }),
      before,
      after,
      setIndexes: [1],
      lastSession: { sessionDate: "2026-10-20", maxSystemLoad: 60, bestReps: 8 },
    };
    expect(reasons([edit])).toEqual(["load_far_off"]);
    const ok: StagedAction = { ...edit, after: before, setIndexes: [1, 2] };
    expect(decidePolicy([ok])).toEqual({ mode: "direct" });
  });
});

describe("edit far-off uses the equipment step", () => {
  it("needs 2 steps for an edit too", () => {
    const wide = { slug: "stack", baseKg: null, stepKg: 5, discreteValues: null };
    const mk = (equipment: typeof wide | null): StagedAction => {
      const before = snapshot();
      const after = snapshot({
        entries: [entry({ setIndex: 1, loadKg: 37 }), entry({ setIndex: 2 })],
      });
      return {
        kind: "edit_group",
        input: editInput({ load_kg: 37 }),
        before,
        after: { ...after, exercise: { ...after.exercise, equipment } },
        setIndexes: [1],
        lastSession: { sessionDate: "2026-10-20", maxSystemLoad: 30, bestReps: 8 },
      };
    };
    // 23 % away, but only 1.4 steps of 5 kg
    expect(decidePolicy([mk(wide)])).toEqual({ mode: "direct" });
    // unknown step: the 20 % rule alone applies
    expect(decidePolicy([mk(null)])).toEqual({ mode: "confirm", reasons: ["load_far_off"] });
  });
});

describe("isLoadFarOff", () => {
  it("needs more than 20 % and at least 2 steps", () => {
    // ref 60, step 2.5: 20 % = 12 kg, 2 steps = 5 kg
    expect(isLoadFarOff(72, 60, 2.5)).toBe(false); // exactly 20 %
    expect(isLoadFarOff(72.5, 60, 2.5)).toBe(true);
    expect(isLoadFarOff(48, 60, 2.5)).toBe(false);
    expect(isLoadFarOff(47.5, 60, 2.5)).toBe(true);
  });
  it("respects the 2-step minimum on light loads", () => {
    // ref 10: 20 % = 2 kg, but 2 steps of 2.5 = 5 kg
    expect(isLoadFarOff(13, 10, 2.5)).toBe(false);
    expect(isLoadFarOff(15, 10, 2.5)).toBe(true);
    expect(isLoadFarOff(14.9, 10, 2.5)).toBe(false);
  });
  it("uses only the 20 % rule without a step", () => {
    expect(isLoadFarOff(13, 10, null)).toBe(true);
  });
  it("skips when a value is missing", () => {
    expect(isLoadFarOff(null, 60, 2.5)).toBe(false);
    expect(isLoadFarOff(60, null, 2.5)).toBe(false);
  });
});

describe("isRepsFarOff", () => {
  it("fires at twice the reference", () => {
    expect(isRepsFarOff(15, 8)).toBe(false);
    expect(isRepsFarOff(16, 8)).toBe(true);
    expect(isRepsFarOff(50, 15)).toBe(true);
  });
  it("skips null or zero references", () => {
    expect(isRepsFarOff(50, null)).toBe(false);
    expect(isRepsFarOff(50, 0)).toBe(false);
  });
});

describe("far-off reference (SPEC 5.6d)", () => {
  // Barbell step 2.5 kg (helpers' squat): 60 kg is far from 95 but not from 55.
  const log = (suggested: number | null, last: number | null) =>
    logAction({
      entries: [entry({ loadKg: 60 })],
      suggestedSystemLoad: suggested,
      lastSession:
        last === null ? null : { sessionDate: "2026-09-21", maxSystemLoad: last, bestReps: 8 },
    });

  it("uses the stored suggestion first", () => {
    const a = log(95, 55);
    expect(farOffLoadRef(a)).toEqual({ load: 60, ref: 95, source: "suggested" });
    expect(reasons([a])).toEqual(["load_far_off"]);
  });

  it("a close suggestion wins over a far last session", () => {
    expect(reasons([log(62.5, 30)])).toEqual("direct");
  });

  it("falls back to the last session, and to no check at all", () => {
    expect(farOffLoadRef(log(null, 30))).toEqual({ load: 60, ref: 30, source: "last" });
    expect(reasons([log(null, null)])).toEqual("direct");
  });

  it("an edit compares with the suggestion the group was logged against", () => {
    const e: StagedAction = {
      kind: "edit_group",
      input: editInput({ load_kg: 60 }),
      before: snapshot(),
      after: snapshot({ entries: [entry({ setIndex: 1, loadKg: 60 }), entry({ setIndex: 2 })] }),
      setIndexes: [1],
      lastSession: null,
      suggestedSystemLoad: 95,
    };
    expect(farOffLoadRef(e)).toMatchObject({ ref: 95, source: "suggested" });
  });

  it("a band set with no kg has no system load, so no check", () => {
    const pullUp = {
      ...squat,
      type: "bodyweight_plus" as const,
      loadBasis: "bodyweight_plus" as const,
      equipment: null,
    };
    const a = logAction({
      exercise: pullUp,
      entries: [entry({ loadKg: null, addedKg: 0, assistKg: null, band: "red" })],
      bwKg: 80,
      suggestedSystemLoad: 40,
    });
    expect(farOffLoadRef(a)).toBeNull();
  });
});
