import { describe, expect, it } from "vitest";
import {
  applyReadiness,
  driftFor,
  earlierDeloadHint,
  readinessLevel,
} from "../../src/progression/readiness.js";
import type {
  ItemTarget,
  ReadinessSignal,
  SessionRec,
  SetRec,
} from "../../src/progression/types.js";
import { byName, targetsFor } from "./helpers-session.js";

const NOW = "2026-10-27T07:00:00.000Z";
const sig = (kind: ReadinessSignal["kind"], at = "2026-10-27T05:00:00.000Z", lift?: number) =>
  ({ kind, at, ...(lift !== undefined ? { lift } : {}) }) as ReadinessSignal;
const hoursBefore = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

describe("readinessLevel", () => {
  it("no signals -> GREEN; 🙂 adds nothing", () => {
    expect(readinessLevel([], NOW).level).toBe("GREEN");
    expect(readinessLevel([sig("button_ok")], NOW).level).toBe("GREEN");
  });
  it("one signal -> YELLOW", () => {
    expect(readinessLevel([sig("button_tired")], NOW).level).toBe("YELLOW");
    expect(readinessLevel([sig("recovery_low")], NOW).level).toBe("YELLOW");
    expect(readinessLevel([sig("drift", NOW, 7)], NOW).level).toBe("YELLOW");
  });
  it("two distinct signals -> RED", () => {
    expect(readinessLevel([sig("button_tired"), sig("recovery_low")], NOW).level).toBe("RED");
    expect(readinessLevel([sig("button_tired"), sig("chat_sore")], NOW).level).toBe("RED");
  });
  it("sleep + sore + exhausted in chat are ONE signal", () => {
    const r = readinessLevel([sig("chat_bad_sleep"), sig("chat_sore"), sig("chat_exhausted")], NOW);
    expect(r.level).toBe("YELLOW");
    expect(r.counted).toHaveLength(1);
  });
  it("repeated identical signals count once", () => {
    expect(
      readinessLevel([sig("button_tired"), sig("button_tired", hoursBefore(2))], NOW).level,
    ).toBe("YELLOW");
  });
  it("drift on two lifts -> RED; two entries for one lift -> YELLOW", () => {
    expect(readinessLevel([sig("drift", NOW, 1), sig("drift", NOW, 2)], NOW).level).toBe("RED");
    expect(readinessLevel([sig("drift", NOW, 1), sig("drift", NOW, 1)], NOW).level).toBe("YELLOW");
  });
  it("💪 cancels chat signals of the same day but not the other signals", () => {
    expect(readinessLevel([sig("chat_sore"), sig("button_strong")], NOW).level).toBe("GREEN");
    expect(
      readinessLevel([sig("chat_sore"), sig("recovery_low"), sig("button_strong")], NOW).level,
    ).toBe("YELLOW");
    expect(readinessLevel([sig("button_tired"), sig("button_strong")], NOW).level).toBe("YELLOW");
  });
  it("💪 does not cancel a chat signal from another day", () => {
    const yesterdayChat = sig("chat_sore", "2026-10-26T20:00:00.000Z");
    const strongToday = sig("button_strong", "2026-10-27T05:00:00.000Z");
    expect(readinessLevel([yesterdayChat, strongToday], NOW).level).toBe("YELLOW");
  });
  it("expiry boundaries: chat/button 24 h, recovery 3 days, drift never by time", () => {
    expect(readinessLevel([sig("chat_sore", hoursBefore(24))], NOW).level).toBe("YELLOW");
    expect(readinessLevel([sig("chat_sore", hoursBefore(24.01))], NOW).level).toBe("GREEN");
    expect(readinessLevel([sig("button_tired", hoursBefore(24.01))], NOW).level).toBe("GREEN");
    expect(readinessLevel([sig("recovery_low", hoursBefore(72))], NOW).level).toBe("YELLOW");
    expect(readinessLevel([sig("recovery_low", hoursBefore(72.01))], NOW).level).toBe("GREEN");
    expect(readinessLevel([sig("drift", hoursBefore(24 * 20), 3)], NOW).level).toBe("YELLOW");
  });
  it("signals from the future are ignored", () => {
    expect(readinessLevel([sig("button_tired", "2026-10-27T09:00:00.000Z")], NOW).level).toBe(
      "GREEN",
    );
  });
  it("is pure: freezing is the caller's job (asOf decides)", () => {
    const s = [sig("button_tired")];
    expect(readinessLevel(s, NOW).level).toBe("YELLOW");
    expect(readinessLevel(s, "2026-10-29T07:00:00.000Z").level).toBe("GREEN");
  });
});

const set = (reps: number, rir: number, loadKg: number | null = 100): SetRec => ({
  reps,
  rir,
  loadKg,
  addedKg: null,
  assistKg: null,
  band: null,
  rirPlus: false,
  clean: null,
  durationS: null,
});
const rec = (over: Partial<SessionRec> = {}): SessionRec => ({
  date: "2026-10-26",
  exerciseId: 1,
  plannedItemIds: [1],
  source: "bot",
  bwKg: 80,
  week: 5,
  isDeload: false,
  isTest: false,
  readiness: "GREEN",
  perSetUnknown: false,
  hspuStepOrder: null,
  padHeight: null,
  suggestion: { id: 1, systemLoad: 100, repsMin: 8, rirMid: 2 },
  sets: [set(8, 2), set(8, 2)],
  ...over,
});
const target = targetsFor(5, "mon")[2] as ItemTarget;

describe("driftFor", () => {
  it("target reps at RIR 2 (8+2 > 8) is no drift", () => {
    expect(driftFor(rec(), target)).toBe(false);
  });
  it("threshold: reps+RIR == reps_min + rir_mid - 2 is drift, one above is not", () => {
    expect(driftFor(rec({ sets: [set(8, 0)] }), target)).toBe(true); // 8 <= 8
    expect(driftFor(rec({ sets: [set(7, 1)] }), target)).toBe(true); // 8 <= 8
    expect(driftFor(rec({ sets: [set(7, 2)] }), target)).toBe(false); // 9 > 8
  });
  it("missed reps at RIR 0 is drift", () => {
    expect(driftFor(rec({ sets: [set(6, 0)] }), target)).toBe(true);
  });
  it("uses the last logged set", () => {
    expect(driftFor(rec({ sets: [set(8, 0), set(8, 3)] }), target)).toBe(false);
    expect(driftFor(rec({ sets: [set(8, 3), set(6, 0)] }), target)).toBe(true);
  });
  it("compares with the stored suggestion, not with last time", () => {
    // rir_mid 3 raises the bar: 8+2=10 > 8+3-2=9 -> no drift; rir_mid 4 -> 10 <= 10 drift
    expect(
      driftFor(rec({ suggestion: { id: 1, systemLoad: 100, repsMin: 8, rirMid: 3 } }), target),
    ).toBe(false);
    expect(
      driftFor(rec({ suggestion: { id: 1, systemLoad: 100, repsMin: 8, rirMid: 4 } }), target),
    ).toBe(true);
  });
  it("needs a stored suggestion and the suggested load", () => {
    expect(driftFor(rec({ suggestion: null, sets: [set(6, 0)] }), target)).toBe(false);
    expect(driftFor(rec({ sets: [set(6, 0, 90)] }), target)).toBe(false);
  });
  it("YELLOW and RED sessions, deload, test and unknown imports are excluded", () => {
    const bad = { sets: [set(6, 0)] };
    expect(driftFor(rec({ ...bad, readiness: "YELLOW" }), target)).toBe(false);
    expect(driftFor(rec({ ...bad, readiness: "RED" }), target)).toBe(false);
    expect(driftFor(rec({ ...bad, isDeload: true }), target)).toBe(false);
    expect(driftFor(rec({ ...bad, isTest: true }), target)).toBe(false);
    expect(driftFor(rec({ ...bad, perSetUnknown: true }), target)).toBe(false);
  });
  it("sets without a logged RIR are skipped", () => {
    const s: SetRec = { ...set(6, 0), rir: null };
    expect(driftFor(rec({ sets: [s] }), target)).toBe(false);
  });
  it("a session never changes its own level: drift only flows in as a later signal", () => {
    const sess = rec({ sets: [set(6, 0)] });
    const frozen = readinessLevel([], NOW).level;
    expect(driftFor(sess, target)).toBe(true);
    expect(frozen).toBe("GREEN"); // the same session keeps its frozen GREEN
    expect(readinessLevel([sig("drift", NOW, 1)], NOW).level).toBe("YELLOW"); // next session
  });
  it("bodyweight_plus: system load from bw + added - assist", () => {
    const s: SetRec = { ...set(4, 0, null), addedKg: 10, assistKg: 0 };
    const r = rec({
      bwKg: 80,
      suggestion: { id: 1, systemLoad: 90, repsMin: 5, rirMid: 2 },
      sets: [s],
    });
    expect(driftFor(r, target)).toBe(true);
    expect(driftFor({ ...r, bwKg: 82 }, target)).toBe(false);
  });
});

const hiddenIds = (m: Map<number, { hidden?: boolean }>) =>
  [...m.entries()].filter(([, v]) => v.hidden).map(([k]) => k);

describe("applyReadiness", () => {
  it("GREEN: plan as written", () => {
    const r = applyReadiness(targetsFor(1, "mon"), "GREEN", "mon");
    expect(r.perItem.size).toBe(0);
    expect(r.restDay).toBe(false);
  });

  describe("YELLOW", () => {
    it("Mon: drops Low, main lifts get RIR 2.5, others untouched", () => {
      const items = targetsFor(1, "mon");
      const { perItem } = applyReadiness(items, "YELLOW", "mon");
      expect(perItem.get(byName(items, "Hanging leg").plannedItemId)).toEqual({ hidden: true });
      expect(perItem.get(byName(items, "Chest-supported").plannedItemId)).toEqual({ rirMid: 2.5 });
      expect(perItem.get(byName(items, "Romanian").plannedItemId)).toEqual({ rirMid: 2.5 });
      expect(perItem.get(byName(items, "Lat pulldown").plannedItemId)).toBeUndefined(); // Medium
      expect(perItem.get(byName(items, "Pull warm-up").plannedItemId)).toBeUndefined();
      expect(hiddenIds(perItem)).toHaveLength(1);
    });
    it("Wed: HIIT rounds halved, nothing else changes", () => {
      const items = targetsFor(1, "wed");
      const hiit = byName(items, "Bike HIIT");
      const { perItem } = applyReadiness(items, "YELLOW", "wed");
      expect(perItem.get(hiit.plannedItemId)).toEqual({
        hiit: { rounds: 3, work_s: 30, rest_s: 90 },
      });
      expect(perItem.size).toBe(1);
    });
    it("rounds are halved rounded down: 8 -> 4, 7 -> 3, 1 -> hidden", () => {
      const hiit = byName(targetsFor(1, "wed"), "Bike HIIT");
      const run = (rounds: number) =>
        applyReadiness(
          [{ ...hiit, hiit: { rounds, work_s: 30, rest_s: 90 } }],
          "YELLOW",
          "wed",
        ).perItem.get(hiit.plannedItemId);
      expect(run(8)?.hiit?.rounds).toBe(4);
      expect(run(7)?.hiit?.rounds).toBe(3);
      expect(run(1)).toEqual({ hidden: true, hiit: null });
    });
    it("Fri: Low prehab/accessory dropped, squat/press/row at 2.5, Bulgarian (Medium) untouched", () => {
      const items = targetsFor(1, "fri");
      const { perItem } = applyReadiness(items, "YELLOW", "fri");
      expect(perItem.get(byName(items, "Face pull").plannedItemId)).toEqual({ hidden: true });
      expect(perItem.get(byName(items, "Curl").plannedItemId)).toEqual({ hidden: true });
      for (const n of ["Squat / hack", "Incline DB", "Cable / machine row"])
        expect(perItem.get(byName(items, n).plannedItemId)).toEqual({ rirMid: 2.5 });
      expect(perItem.get(byName(items, "Bulgarian").plannedItemId)).toBeUndefined();
    });
    it("skill work is never dropped by YELLOW, even when Low", () => {
      const skill = {
        ...byName(targetsFor(2, "tue"), "Handstand practice"),
        priority: "Low" as const,
      };
      expect(
        applyReadiness([skill], "YELLOW", "tue").perItem.get(skill.plannedItemId),
      ).toBeUndefined();
    });
    it("deload/easy items get no RIR override", () => {
      const items = targetsFor(4, "fri");
      const { perItem } = applyReadiness(items, "YELLOW", "fri");
      expect(perItem.get(byName(items, "Squat / hack").plannedItemId)).toBeUndefined();
    });
    it("custom isMainLift predicate overrides the heuristic", () => {
      const items = targetsFor(1, "mon");
      const lat = byName(items, "Lat pulldown");
      const { perItem } = applyReadiness(items, "YELLOW", "mon", (i) => i === lat);
      expect(perItem.get(lat.plannedItemId)).toEqual({ rirMid: 2.5 });
      expect(perItem.get(byName(items, "Romanian").plannedItemId)).toBeUndefined();
    });
  });

  describe("RED", () => {
    const easy = { easy: { sets: 2, rirMin: 3, rirMax: 4 } };
    it("Mon: keeps pull-up as easy volume and warm-up, hides the rest", () => {
      const items = targetsFor(1, "mon");
      const { perItem, restDay } = applyReadiness(items, "RED", "mon");
      expect(perItem.get(byName(items, "pull-up").plannedItemId)).toEqual(easy);
      expect(perItem.get(byName(items, "Pull warm-up").plannedItemId)).toBeUndefined();
      expect(hiddenIds(perItem).sort()).toEqual(
        ["Chest-supported", "Romanian", "Lat pulldown", "Hanging"]
          .map((n) => byName(items, n).plannedItemId)
          .sort(),
      );
      expect(restDay).toBe(false);
    });
    it("Tue: skill_strength (HSPU) and skill_practice (handstand) kept at easy volume", () => {
      const items = targetsFor(2, "tue");
      const { perItem } = applyReadiness(items, "RED", "tue");
      expect(perItem.get(byName(items, "Handstand practice").plannedItemId)).toEqual(easy);
      expect(perItem.get(byName(items, "HSPU").plannedItemId)).toEqual(easy);
      for (const n of ["Overhead press", "Bench press", "Squat", "Lateral raise"])
        expect(perItem.get(byName(items, n).plannedItemId)).toEqual({ hidden: true });
    });
    it("Wed: HIIT removed even though it is PRIMARY; mobility and warm-ups kept", () => {
      const items = targetsFor(1, "wed");
      const hiit = byName(items, "Bike HIIT");
      expect(hiit.priority).toBe("PRIMARY");
      const { perItem, restDay } = applyReadiness(items, "RED", "wed");
      expect(perItem.get(hiit.plannedItemId)).toEqual({ hidden: true, hiit: null });
      expect(hiddenIds(perItem)).toEqual([hiit.plannedItemId]);
      expect(restDay).toBe(false);
    });
    it("Fri: nothing but warm-up left -> restDay", () => {
      const items = targetsFor(1, "fri");
      const { perItem, restDay } = applyReadiness(items, "RED", "fri");
      expect(restDay).toBe(true);
      expect(perItem.get(byName(items, "Full-body warm-up").plannedItemId)).toBeUndefined();
      expect(hiddenIds(perItem)).toHaveLength(items.length - 1);
    });
    it("rest day only on Friday", () => {
      const items = targetsFor(1, "fri");
      expect(applyReadiness(items, "RED", "mon").restDay).toBe(false);
    });
    it("Thu: class kept, advice flag set (go easy or skip)", () => {
      const items = targetsFor(1, "thu");
      const r = applyReadiness(items, "RED", "thu");
      expect(r.classAdvice).toBe(true);
      expect(hiddenIds(r.perItem)).toEqual([]);
      expect(applyReadiness(items, "YELLOW", "thu").classAdvice).toBe(false);
    });
    it("skill work is cut last: every plan day with skill work keeps it under RED", () => {
      for (const wd of ["mon", "tue", "wed", "thu", "fri"] as const) {
        for (const week of [1, 3, 5]) {
          const items = targetsFor(week, wd);
          const { perItem } = applyReadiness(items, "RED", wd);
          for (const i of items)
            if (i.tags.includes("skill_strength") || i.tags.includes("skill_practice"))
              expect(perItem.get(i.plannedItemId)?.hidden).toBeUndefined();
        }
      }
    });
    it("RED never keeps HIIT on any plan day", () => {
      for (const wd of ["mon", "tue", "wed", "thu", "fri"] as const)
        for (let week = 1; week <= 12; week++) {
          const items = targetsFor(week, wd);
          const { perItem } = applyReadiness(items, "RED", wd);
          for (const i of items)
            if (i.hiit) expect(perItem.get(i.plannedItemId)).toEqual({ hidden: true, hiit: null });
        }
    });
  });
});

describe("earlierDeloadHint", () => {
  it("RED twice in a row", () => {
    expect(earlierDeloadHint(["GREEN", "RED", "RED"], [])).toBe(true);
    expect(earlierDeloadHint(["RED", "YELLOW", "RED"], [])).toBe(false);
    expect(earlierDeloadHint(["RED"], [])).toBe(false);
  });
  it("recovery <= 2 for 2 weeks", () => {
    expect(earlierDeloadHint([], [4, 2, 1])).toBe(true);
    expect(earlierDeloadHint([], [2, 3, 2])).toBe(false);
    expect(earlierDeloadHint([], [2, null])).toBe(false);
    expect(earlierDeloadHint([], [2])).toBe(false);
  });
});
