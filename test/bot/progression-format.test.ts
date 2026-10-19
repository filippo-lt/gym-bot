import { describe, expect, it } from "vitest";
import { formatToday } from "../../src/bot/format.js";
import {
  labelText,
  levelLines,
  loadText,
  suggestionNotes,
} from "../../src/bot/progression-format.js";
import { formatNext } from "../../src/bot/query-format.js";
import type { AdviceItem, SessionAdvice } from "../../src/progression/session-advice.js";
import type { ExerciseInfo, Suggestion } from "../../src/progression/types.js";
import { nextItem } from "../../src/queries/plan-overview.js";
import { sessionFor } from "./helpers.js";

const equip = (slug: string) => ({
  slug,
  baseKg: null,
  stepKg: 2.5,
  discreteValues: null,
  bands: {},
});
const ex = (
  id: number,
  slug: string,
  type: ExerciseInfo["type"],
  loadBasis: ExerciseInfo["loadBasis"],
): ExerciseInfo => ({
  id,
  slug,
  type,
  loadBasis,
  isMainLift: false,
  equipment: equip(slug),
});

const EXERCISES: Record<number, ExerciseInfo> = {
  1: ex(1, "pull_up", "bodyweight_plus", "bodyweight_plus"),
  2: ex(2, "romanian_deadlift", "weighted", "barbell_total"),
  3: ex(3, "lat_pulldown", "weighted", "stack"),
  4: ex(4, "lateral_raise", "weighted", "per_hand"),
  5: ex(5, "squat", "weighted", "barbell_total"),
  6: ex(6, "hack_squat", "weighted", "stack"),
  7: ex(7, "hspu", "skill_ladder", null),
  8: ex(8, "cable_row", "weighted", "stack"),
};

const sug = (over: Partial<Suggestion> = {}): Suggestion => ({
  sets: 3,
  repsMin: 6,
  repsMax: 6,
  rirMin: 1,
  rirMax: 2,
  labels: [],
  ...over,
});

const adv = (plannedItemId: number, over: Partial<AdviceItem> = {}): AdviceItem => ({
  plannedItemId,
  suggestions: {},
  hidden: false,
  optional: false,
  skipOffer: false,
  friday: null,
  prescription: null,
  hiit: undefined,
  pullup: null,
  hspu: null,
  hspuStep: null,
  hspuAdvance: null,
  ...over,
});

function advice(items: AdviceItem[], over: Partial<SessionAdvice> = {}): SessionAdvice {
  return {
    mode: "live",
    date: "2026-10-26",
    level: "GREEN",
    levelKinds: [],
    restDaySuggested: false,
    askClassFirst: false,
    needsBodyweight: false,
    bodyweightDate: null,
    classAdvice: false,
    isTest: false,
    earlierDeloadHint: null,
    items: new Map(items.map((i) => [i.plannedItemId, i])),
    exercises: EXERCISES,
    ...over,
  };
}

describe("loadText: the unit convention", () => {
  const barbell = { type: "weighted", loadBasis: "barbell_total" } as const;
  it.each([
    [barbell, sug({ loadKg: 62.5 }), "62.5 kg"],
    [{ type: "weighted", loadBasis: "per_hand" } as const, sug({ loadKg: 20 }), "20 kg per hand"],
    [{ type: "weighted", loadBasis: "stack" } as const, sug({ loadKg: 40 }), "40 kg"],
    [EXERCISES[1] as ExerciseInfo, sug({ addedKg: 5 }), "+5 kg"],
    [EXERCISES[1] as ExerciseInfo, sug({ addedKg: 0 }), "BW"],
    [EXERCISES[1] as ExerciseInfo, sug({ assistKg: 10, band: "red" }), "red band"],
    [EXERCISES[1] as ExerciseInfo, sug({ assistKg: 12.5 }), "12.5 kg assist"],
    [barbell, sug({ ask: "load" }), null],
    [barbell, sug(), null],
  ])("%j %j -> %s", (exercise, s, expected) => {
    expect(loadText(exercise, s)).toBe(expected);
  });
});

describe("label texts", () => {
  it("are plain short English", () => {
    expect(labelText("estimate")).toBe("estimate");
    expect(labelText("estimate_check_first_set")).toBe("estimate — check your first set");
    expect(labelText("back_after_break")).toBe("back after a break");
    expect(labelText("baseline_ask_load")).toBe("baseline — tell me your weight");
    expect(labelText("bw_stale", { bodyweightDate: "2026-10-12" })).toBe(
      "BW from 12 Oct — send /bw <kg>",
    );
    expect(labelText("bw_stale")).toBe("no bodyweight yet — send /bw <kg>");
    expect(labelText("friday_reduced", { heavyGroup: "legs" })).toBe(
      "reduced (heavy legs Thursday) — or skip",
    );
  });

  it("a notes list has no duplicates and an ask adds its own text", () => {
    expect(suggestionNotes(sug({ labels: ["baseline_ask_load"], ask: "load" }))).toEqual([
      "baseline — tell me your weight",
    ]);
    expect(
      suggestionNotes(sug({ labels: ["estimate", "friday_reduced"] }), {}, ["friday_reduced"]),
    ).toEqual(["estimate"]);
  });

  it("level lines: nothing for GREEN, YELLOW and RED say what changed", () => {
    expect(levelLines("GREEN", [])).toEqual([]);
    expect(levelLines(null, [])).toEqual([]);
    expect(levelLines("YELLOW", ["chat_bad_sleep"])[0]).toContain("YELLOW");
    expect(levelLines("YELLOW", ["chat_bad_sleep"])[0]).toContain("bad sleep");
    const red = levelLines("RED", ["button_tired", "chat_sore"], {
      restDay: true,
      classAdvice: true,
    });
    expect(red.join("\n")).toContain("RED");
    expect(red.join("\n")).toContain("Go easy in class tonight, or skip it.");
    expect(red.join("\n")).toContain("rest day");
  });
});

describe("formatToday with advice", () => {
  const mon = sessionFor(5, "mon", "2026-10-26");

  it("W5 Monday: loads, labels, break and an ask", () => {
    const a = advice([
      adv(2, {
        suggestions: {
          1: sug({ sets: 4, repsMin: 3, repsMax: 3, addedKg: 7.5, labels: ["estimate"] }),
        },
      }),
      adv(4, {
        suggestions: {
          2: sug({ repsMin: 6, repsMax: 6, loadKg: 85, labels: ["estimate_check_first_set"] }),
        },
      }),
      adv(5, {
        suggestions: {
          3: sug({ sets: 2, repsMin: 8, repsMax: 12, loadKg: 45, labels: ["back_after_break"] }),
        },
      }),
    ]);
    const out = formatToday(mon, a);
    expect(out).toMatchSnapshot();
    expect(out).toContain("3 × 6 · 85 kg · RIR 1–2");
    expect(out).toContain("<i>estimate — check your first set</i>");
    expect(out).toContain("<i>back after a break</i>");
  });

  it("a done item shows no baseline ask", () => {
    const asked = advice([
      adv(5, { suggestions: { 3: sug({ ask: "load", labels: ["baseline_ask_load"] }) } }),
    ]);
    expect(formatToday(mon, asked)).toContain("baseline — tell me your weight");
    const done = {
      ...mon,
      items: mon.items.map((i) => (i.plannedItemId === 5 ? { ...i, status: "done" as const } : i)),
    };
    const out = formatToday(done, asked);
    expect(out).toContain("✓ ");
    expect(out).not.toContain("tell me your weight");
  });

  it("an item with no history asks for the weight, a stale bodyweight is dated", () => {
    const a = advice(
      [
        adv(2, {
          suggestions: {
            1: sug({
              sets: 4,
              repsMin: 3,
              repsMax: 3,
              addedKg: 5,
              labels: ["bw_stale", "estimate"],
            }),
          },
        }),
        adv(4, {
          suggestions: { 2: sug({ labels: ["baseline_ask_load"], ask: "load" }) },
        }),
      ],
      { bodyweightDate: "2026-10-12", needsBodyweight: true },
    );
    const out = formatToday(mon, a);
    expect(out).toContain("+5 kg");
    expect(out).toContain("BW from 12 Oct — send /bw &lt;kg&gt;");
    expect(out).toContain("baseline — tell me your weight");
    expect(out).not.toMatch(/<kg>/);
  });

  it("OR items list each option, dumbbells say per hand, bodyweight is BW", () => {
    const tue = sessionFor(5, "tue", "2026-10-27");
    const a = advice([
      adv(6, {
        suggestions: {
          5: sug({ repsMin: 5, repsMax: 6, loadKg: 100, labels: ["estimate"] }),
          6: sug({ loadKg: 120, labels: [] }),
        },
      }),
      adv(7, { suggestions: { 4: sug({ sets: 2, repsMin: 12, repsMax: 15, loadKg: 8 }) } }),
    ]);
    const out = formatToday(tue, a);
    expect(out).toContain("Squat: 100 kg (estimate)");
    expect(out).toContain("Hack squat: 120 kg");
    expect(out).toContain("8 kg per hand");
  });

  it("HSPU shows the current step and its reps, with the pad", () => {
    const tue = sessionFor(5, "tue", "2026-10-27");
    const a = advice([
      adv(3, {
        hspu: { sets: 3, repsMin: 4, repsMax: 5, tempo: null, fromPlan: false },
        hspuStep: { order: 2, name: "Wall HSPU negative", padHeight: 10 },
      }),
    ]);
    const out = formatToday(tue, a);
    expect(out).toContain("<b>HSPU — Wall HSPU negative</b> — 3 × 4–5 · pad 10");
  });

  it("YELLOW header and dropped items; RED Friday suggests a rest day", () => {
    const hiddenMon = advice([adv(5, { hidden: true }), adv(6, { hidden: true })], {
      level: "YELLOW",
      levelKinds: ["chat_bad_sleep"],
    });
    const out = formatToday(mon, hiddenMon);
    expect(out).toContain("🟡 YELLOW day (bad sleep)");
    expect(out).toContain("Dropped today: Lat pulldown, Hanging leg raise or hanging knee raise");
    expect(out).not.toContain("5. <b>Lat pulldown");
    const fri = sessionFor(5, "fri", "2026-10-30", { thursday: { heavy: [] } });
    const red = formatToday(
      fri,
      advice(
        fri.items.map((i) => adv(i.plannedItemId, { hidden: true })),
        { level: "RED", levelKinds: ["button_tired", "chat_sore"], restDaySuggested: true },
      ),
    );
    expect(red).toContain("🔴 RED day");
    expect(red).toContain("a rest day is suggested");
  });

  it("RED Thursday: go easy in class or skip", () => {
    const thu = sessionFor(5, "thu", "2026-10-29");
    const out = formatToday(thu, advice([], { level: "RED", classAdvice: true }));
    expect(out).toContain("Go easy in class tonight, or skip it.");
  });

  it("Friday with legs heavy: reduced squat and a skippable Bulgarian", () => {
    const fri = sessionFor(5, "fri", "2026-10-30", { thursday: { heavy: ["legs"] } });
    const a = advice([
      adv(2, {
        suggestions: {
          5: sug({ sets: 2, repsMin: 4, repsMax: 4, rirMin: 3, rirMax: 4, loadKg: 90 }),
        },
        friday: { kind: "reduce", sets: 2, reps: 4, rirMin: 3, rirMax: 4, skippable: true },
        skipOffer: true,
      }),
      adv(5, { friday: { kind: "offer_skip" }, skipOffer: true }),
    ]);
    const out = formatToday(fri, a);
    expect(out).toMatchSnapshot();
    expect(out).toContain("reduced to 2 × 4 (heavy legs Thursday) — or skip");
    expect(out).toContain("can skip (heavy legs Thursday)");
    expect(out).toContain("2 × 4 · RIR 3–4");
    expect(out).toContain("Squat: 90 kg");
    expect(out).not.toContain("⚠️");
  });

  it.each(["done", "skipped", "modified"] as const)(
    "a %s item shows no Friday or max-test text",
    (status) => {
      const fri = sessionFor(5, "fri", "2026-10-30", { thursday: { heavy: ["legs"] } });
      const a = advice([
        adv(2, {
          friday: { kind: "reduce", sets: 2, reps: 4, rirMin: 3, rirMax: 4, skippable: true },
          pullup: {
            mode: "fallback_assisted",
            maxTestFirst: true,
            sets: 4,
            repsMin: 6,
            repsMax: 6,
            labels: ["max_test_first"],
            afterMaxTest: {
              thresholdReps: 4,
              bw: { sets: 4, repsMin: 4, repsMax: 6 },
              assisted: { sets: 4, repsMin: 6, repsMax: 6 },
            },
          },
        }),
        adv(5, { friday: { kind: "offer_skip" }, skipOffer: true }),
      ]);
      const settled = {
        ...fri,
        items: fri.items.map((i) => ({ ...i, status })),
      };
      const open = formatToday(fri, a);
      expect(open).toContain("or skip");
      expect(open).toContain("can skip (heavy legs Thursday)");
      const out = formatToday(settled, a);
      expect(out).not.toContain("or skip");
      expect(out).not.toContain("can skip");
      expect(out).not.toContain("Start with one max clean set");
      expect(out).not.toContain("Then bodyweight");
    },
  );

  it("Friday without a class report asks first", () => {
    const fri = sessionFor(5, "fri", "2026-10-30", { thursday: "not_reported" });
    const out = formatToday(fri, advice([], { askClassFirst: true }));
    expect(out).toContain("How was Thursday's class? /class");
    expect(out).not.toContain("Thursday class: not reported");
    expect(out.indexOf("How was Thursday's class?")).toBeLessThan(out.indexOf("1. "));
  });

  it("max test first spells out the plan; a fallback is not repeated", () => {
    const a = advice([
      adv(2, {
        pullup: {
          mode: "fallback_assisted",
          maxTestFirst: true,
          sets: 4,
          repsMin: 6,
          repsMax: 6,
          labels: ["max_test_first"],
          afterMaxTest: {
            thresholdReps: 4,
            bw: { sets: 4, repsMin: 4, repsMax: 6 },
            assisted: { sets: 4, repsMin: 6, repsMax: 6 },
          },
        },
      }),
    ]);
    const out = formatToday(mon, a);
    expect(out).toContain("Start with one max clean set");
    expect(out).toContain("Then bodyweight 4 × 4–6 if you got 4+ clean reps, else assisted 4 × 6");
    expect(out).not.toContain("Not at 6 clean reps yet");
  });

  it("short mode: optional items are flagged and the header says short", () => {
    const a = advice([adv(5, { optional: true }), adv(6, { hidden: true })]);
    const out = formatToday(mon, a, { short: true });
    expect(out).toContain("· short");
    expect(out).toContain("(optional)");
  });

  it("the earlier-deload trigger adds no text line (the card is a separate message)", () => {
    const out = formatToday(mon, advice([], { earlierDeloadHint: "sessions" }));
    expect(out).toBe(formatToday(mon, advice([], { earlierDeloadHint: null })));
  });

  it("without advice it is the plain session (unchanged)", () => {
    expect(formatToday(mon, null)).toBe(formatToday(mon));
  });
});

describe("formatNext with advice", () => {
  it("shows the suggested load and skips hidden items", () => {
    const mon = sessionFor(5, "mon", "2026-10-26");
    const a = advice([
      adv(1, { hidden: true }),
      adv(2, {
        suggestions: {
          1: sug({ sets: 4, repsMin: 3, repsMax: 3, addedKg: 7.5, labels: ["estimate"] }),
        },
      }),
    ]);
    const hidden = new Set([1]);
    const out = formatNext(nextItem(mon, hidden), a, []);
    expect(out).toContain("<b>Next up</b> · 1 of 5");
    expect(out).toContain("+7.5 kg");
    expect(out).toContain("estimate");
  });
});
