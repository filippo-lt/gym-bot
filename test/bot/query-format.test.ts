import { describe, expect, it } from "vitest";
import {
  CALLBACK_MAX_BYTES,
  cb,
  parseCallback,
  parseHistoryCallback,
} from "../../src/bot/callbacks.js";
import {
  formatHistory,
  formatHistoryChoice,
  formatNext,
  formatPlan,
  historyLines,
} from "../../src/bot/query-format.js";
import type { ExerciseHistory, HistorySession, HistorySet } from "../../src/queries/history.js";
import { groupPhases, nextItem, type PlanOverview } from "../../src/queries/plan-overview.js";
import { sessionFor } from "./helpers.js";

const set = (over: Partial<HistorySet> = {}): HistorySet => ({
  setIndex: 1,
  reps: 5,
  loadKg: null,
  addedKg: null,
  assistKg: null,
  durationS: null,
  distanceM: null,
  padHeight: null,
  rir: null,
  rirPlus: false,
  clean: null,
  ...over,
});

const session = (over: Partial<HistorySession> = {}): HistorySession => ({
  sessionDate: "2026-10-20",
  weekday: "tue",
  week: 4,
  phase: "Deload",
  isDeload: true,
  isTest: false,
  source: "bot",
  perSetUnknown: false,
  hspuStep: null,
  sets: [set()],
  ...over,
});

const hist = (
  exercise: Partial<ExerciseHistory["exercise"]>,
  sessions: HistorySession[],
  totalSessions = sessions.length,
): ExerciseHistory => ({
  exercise: {
    id: 1,
    slug: "squat",
    name: "Squat",
    type: "weighted",
    loadBasis: "barbell_total",
    ...exercise,
  },
  totalSessions,
  sessions,
});

const sets3 = (over: Partial<HistorySet>) => [1, 2, 3].map((i) => set({ setIndex: i, ...over }));

describe("historyLines", () => {
  it("barbell total, RIR from the last set, deload marker, imported marker", () => {
    const h = hist({}, [
      session({
        source: "import",
        sets: [...sets3({ loadKg: 60 }).slice(0, 2), set({ setIndex: 3, loadKg: 60, rir: 3 })],
      }),
    ]);
    expect(historyLines(h)).toEqual(["Tue 20 Oct · W4 deload — 3 × 5 · 60 kg · RIR 3 · imported"]);
  });

  it("test week, no plan week, 4+ RIR, differing sets", () => {
    const h = hist({}, [
      session({
        sessionDate: "2026-12-15",
        isDeload: false,
        isTest: true,
        week: 12,
        sets: [
          set({ setIndex: 1, reps: 8, loadKg: 60 }),
          set({ setIndex: 2, reps: 8, loadKg: 60 }),
          set({ setIndex: 3, reps: 6, loadKg: 57.5, rir: 4, rirPlus: true }),
        ],
      }),
      session({
        sessionDate: "2026-09-01",
        week: null,
        isDeload: false,
        sets: [set({ loadKg: 50 })],
      }),
    ]);
    expect(historyLines(h)).toEqual([
      "Tue 15 Dec · W12 test — 8, 8, 6 reps · 60/60/57.5 kg · RIR 4+",
      "Tue 1 Sep — 1 × 5 · 50 kg",
    ]);
  });

  it("dumbbells are per hand, stack is the stack value", () => {
    const dumbbell = hist({ name: "Lateral raise", loadBasis: "per_hand" }, [
      session({ isDeload: false, sets: sets3({ reps: 12, loadKg: 12.5 }) }),
    ]);
    expect(historyLines(dumbbell)[0]).toBe("Tue 20 Oct · W4 — 3 × 12 · 12.5 kg per hand");
    const stack = hist({ name: "Cable row", loadBasis: "stack" }, [
      session({ isDeload: false, sets: sets3({ reps: 10, loadKg: 45 }) }),
    ]);
    expect(historyLines(stack)[0]).toBe("Tue 20 Oct · W4 — 3 × 10 · 45 kg");
  });

  it("pull-ups: added, assist, bodyweight, clean flag", () => {
    const pull = (over: Partial<HistorySet>) =>
      hist({ name: "Pull-up", type: "bodyweight_plus", loadBasis: "bodyweight_plus" }, [
        session({ isDeload: false, sets: sets3({ reps: 4, ...over }) }),
      ]);
    expect(historyLines(pull({ addedKg: 10, clean: true }))[0]).toBe(
      "Tue 20 Oct · W4 — 3 × 4 · +10 kg · clean",
    );
    expect(historyLines(pull({ assistKg: 10, clean: false }))[0]).toBe(
      "Tue 20 Oct · W4 — 3 × 4 · 10 kg assist · not clean",
    );
    expect(historyLines(pull({}))[0]).toBe("Tue 20 Oct · W4 — 3 × 4 · bodyweight");
  });

  it("per-set-unknown import rows say the split is unknown", () => {
    const h = hist({}, [
      session({
        source: "import",
        perSetUnknown: true,
        isDeload: false,
        sets: [set({ reps: 18, loadKg: 60, rir: 2 })],
      }),
    ]);
    expect(historyLines(h)[0]).toBe(
      "Tue 20 Oct · W4 — 18 reps total (split unknown) · 60 kg · RIR 2 · imported",
    );
  });

  it("HSPU step and pad, timed sets", () => {
    const hspu = hist({ name: "HSPU", type: "skill_ladder", loadBasis: null }, [
      session({
        isDeload: false,
        hspuStep: "Partial ROM wall HSPU",
        sets: sets3({ reps: 3, padHeight: 10, clean: true }),
      }),
    ]);
    expect(historyLines(hspu)[0]).toBe(
      "Tue 20 Oct · W4 — 3 × 3 · Partial ROM wall HSPU · pad 10 · clean",
    );
    const timed = hist({ name: "Plank", type: "timed", loadBasis: null }, [
      session({ isDeload: false, sets: sets3({ reps: null, durationS: 45 }) }),
    ]);
    expect(historyLines(timed)[0]).toBe("Tue 20 Oct · W4 — 3 × 45 s");
  });
});

describe("formatHistory", () => {
  it("titles with the count and escapes HTML", () => {
    const text = formatHistory(hist({ name: "A <b> & B" }, [session()], 12));
    expect(text.split("\n")[0]).toBe("<b>A &lt;b&gt; &amp; B</b> — last 1 of 12 sessions");
  });
  it("says so when nothing is logged", () => {
    expect(formatHistory(hist({}, []))).toBe("No Squat logged yet.");
  });
  it("stays under the length guard", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      session({
        sessionDate: `2026-10-${String(10 + i).padStart(2, "0")}`,
        sets: sets3({ loadKg: 60 }),
      }),
    );
    expect(formatHistory(hist({}, many)).length).toBeLessThanOrEqual(4000);
  });
});

describe("history choice", () => {
  it("one button per candidate with hx data", () => {
    const m = formatHistoryChoice("sq<", [
      { id: 3, name: "Squat" },
      { id: 7, name: "Hack squat" },
    ]);
    expect(m.text).toBe('Which exercise is "sq&lt;"?');
    expect(m.keyboard).toEqual([
      [{ text: "Squat", data: "hx:3" }],
      [{ text: "Hack squat", data: "hx:7" }],
    ]);
  });
  it("hx callbacks are short, parse on their own and stay out of the flow's union", () => {
    expect(Buffer.byteLength(cb.history(2_147_483_647))).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    expect(parseHistoryCallback("hx:12")).toEqual({ exerciseId: 12 });
    expect(parseHistoryCallback("hx:")).toBeNull();
    expect(parseHistoryCallback("hx:12:3")).toBeNull();
    expect(parseHistoryCallback("hx:1234567890")).toBeNull();
    expect(parseCallback("hx:12")).toBeNull();
  });
});

describe("nextItem and formatNext", () => {
  it("first open main item, with position", () => {
    const first = nextItem(sessionFor(5, "mon", "2026-10-26"));
    expect(first.kind).toBe("item");
    if (first.kind !== "item") return;
    expect(first.position).toBe(1);
    expect(formatNext(first)).toContain("<b>Next up</b> · 1 of");
  });

  it("skips done and skipped items, counts modified as settled", () => {
    const base = sessionFor(5, "mon", "2026-10-26");
    const mains = base.items.filter((i) => i.subItem === 0);
    const statuses = ["done", "skipped", "modified"] as const;
    const items = base.items.map((i) => {
      const idx = mains.indexOf(i);
      return idx >= 0 && idx < 3 ? { ...i, status: statuses[idx] as (typeof statuses)[number] } : i;
    });
    const next = nextItem({ ...base, items });
    expect(next.kind).toBe("item");
    if (next.kind === "item") {
      expect(next.item.plannedItemId).toBe(mains[3]?.plannedItemId);
      expect(next.position).toBe(4);
    }
  });

  it("all done, rest, before start, finished", () => {
    const base = sessionFor(5, "mon", "2026-10-26");
    const allDone = { ...base, items: base.items.map((i) => ({ ...i, status: "done" as const })) };
    expect(nextItem(allDone)).toEqual({ kind: "all_done" });
    expect(formatNext({ kind: "all_done" })).toContain("done or skipped");
    expect(nextItem({ kind: "rest", date: "2026-10-24", week: 4, phase: "Deload" })).toEqual({
      kind: "rest",
    });
    expect(nextItem({ kind: "before_start", startDate: "2026-09-28" })).toEqual({
      kind: "before_start",
    });
    expect(nextItem({ kind: "finished" })).toEqual({ kind: "finished" });
    expect(formatNext({ kind: "rest" })).toContain("Rest day");
  });

  it("class exposure never counts as next", () => {
    const base = sessionFor(5, "thu", "2026-10-29");
    const exposure = base.items.filter((i) => i.options.some((o) => o.slug === "class_exposure"));
    expect(exposure.length).toBeGreaterThan(0);
    expect(nextItem({ ...base, items: exposure })).toEqual({ kind: "all_done" });
  });
});

describe("plan", () => {
  it("groups consecutive weeks with the same phase", () => {
    expect(
      groupPhases([
        { week: 1, phase: "Base" },
        { week: 2, phase: "Base" },
        { week: 3, phase: "Base" },
        { week: 4, phase: "Deload" },
        { week: 5, phase: "Strength" },
        { week: 6, phase: "Strength" },
        { week: 8, phase: "Strength" },
      ]),
    ).toEqual([
      { fromWeek: 1, toWeek: 3, phase: "Base" },
      { fromWeek: 4, toWeek: 4, phase: "Deload" },
      { fromWeek: 5, toWeek: 6, phase: "Strength" },
      { fromWeek: 8, toWeek: 8, phase: "Strength" },
    ]);
  });

  const overview: PlanOverview = {
    status: "active",
    startDate: "2026-09-28",
    week: 4,
    phase: "Deload",
    weekStart: "2026-10-19",
    weekEnd: "2026-10-25",
    phases: [
      { fromWeek: 1, toWeek: 3, phase: "Base" },
      { fromWeek: 4, toWeek: 4, phase: "Deload" },
    ],
    nextDeload: { week: 4, startDate: "2026-10-19" },
    nextTrainingDay: { date: "2026-10-20", weekday: "tue", focus: "HSPU + push + squat" },
  };
  const none = { week: null, phase: null, weekStart: null, weekEnd: null };

  it("formats an active plan", () => {
    expect(formatPlan(overview)).toBe(
      [
        "<b>Week 4 · Deload</b> · 19–25 Oct",
        "",
        "Phases: W1–3 Base · W4 Deload",
        "Next deload: this week",
        "Next training day: Tue 20 Oct — HSPU + push + squat",
      ].join("\n"),
    );
  });
  it("later deload, before start and finished", () => {
    expect(formatPlan({ ...overview, nextDeload: { week: 8, startDate: "2026-11-16" } })).toContain(
      "Next deload: week 8 (from Mon 16 Nov)",
    );
    expect(formatPlan({ ...overview, ...none, status: "before_start" }).split("\n")[0]).toBe(
      "The plan starts on Mon 28 Sep.",
    );
    expect(
      formatPlan({
        ...overview,
        ...none,
        status: "finished",
        nextDeload: null,
        nextTrainingDay: null,
      }),
    ).toContain("finished");
  });
});
