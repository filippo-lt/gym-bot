import { describe, expect, it } from "vitest";
import {
  budgetReachedText,
  cancelledText,
  clarifyCard,
  classMovesCard,
  confirmCard,
  DIDNT_GET_IT,
  deleteQuestion,
  type EchoView,
  EXPIRED,
  echoMessage,
  editEchoMessage,
  HELP_TEXT,
  heardLine,
  MEMORY_EMPTY,
  memoryList,
  NO_AI_KEY,
  NUMBER_GUARD_FALLBACK,
  reasonPhrases,
  removedText,
  replacedText,
  STALE,
  stripMarkdown,
  TEXT_ONLY,
  UNKNOWN_COMMAND,
  voiceBudgetText,
} from "../../src/bot/log-format.js";
import { HISTORY_UNKNOWN, HISTORY_USAGE, SESSION_USAGE } from "../../src/bot/query-format.js";
import { skipEcho, skipList, skipUndone } from "../../src/bot/skip-format.js";
import { decidePolicy } from "../../src/logging/policy.js";
import type { ResolvedEntry, StagedAction } from "../../src/logging/types.js";
import { editInput, entry, logAction, logInput, snapshot } from "../logging/helpers.js";

const sets = (...over: Partial<ResolvedEntry>[]) =>
  over.map((o, i) => entry({ setIndex: i + 1, ...o }));

const view = (over: Partial<EchoView> = {}): EchoView => ({
  groupId: 11,
  name: "Squat",
  type: "weighted",
  loadBasis: "barbell_total",
  hspuStep: null,
  entries: sets({ rir: null }, { rir: null }, { rir: 2 }),
  place: { kind: "today", weekday: "tue", week: 5 },
  needsClean: false,
  hasRirTarget: false,
  ...over,
});

const render = (m: { text: string; keyboard: { text: string; data: string }[][] }) =>
  `${m.text}\n${m.keyboard.map((r) => r.map((b) => `[${b.text} ${b.data}]`).join(" ")).join("\n")}`;

describe("echo", () => {
  it("uniform sets", () => {
    const m = echoMessage(view());
    expect(m.text).toBe("✓ Squat — 3 × 8 · 60 kg · RIR 2 · Tue W5");
    expect(m.keyboard).toEqual([[{ text: "Undo", data: "ug:11" }]]);
  });

  it("mixed sets", () => {
    const m = echoMessage(
      view({
        entries: sets(
          { reps: 8, loadKg: 60 },
          { reps: 8, loadKg: 60 },
          { reps: 6, loadKg: 57.5, rir: 1 },
        ),
      }),
    );
    expect(m.text).toBe("✓ Squat — 8, 8, 6 reps · 60/60/57.5 kg · RIR 1 · Tue W5");
  });

  it("dumbbells say per hand", () => {
    const m = echoMessage(
      view({
        name: "Incline DB bench",
        loadBasis: "per_hand",
        entries: sets({ loadKg: 12.5, rir: 2 }, { loadKg: 12.5, rir: 2 }),
      }),
    );
    expect(m.text).toBe("✓ Incline DB bench — 2 × 8 · 12.5 kg per hand · RIR 2 · Tue W5");
  });

  it("pull-up added, assist and bodyweight", () => {
    const base = {
      name: "Pull-up",
      type: "bodyweight_plus" as const,
      loadBasis: "bodyweight_plus" as const,
    };
    expect(
      echoMessage(
        view({
          ...base,
          entries: sets({ loadKg: null, reps: 5, addedKg: 10, rir: 1, clean: true }),
        }),
      ).text,
    ).toBe("✓ Pull-up — 1 × 5 · +10 kg · RIR 1 · Tue W5");
    expect(
      echoMessage(
        view({
          ...base,
          entries: sets({ loadKg: null, reps: 5, assistKg: 15, rir: 1, clean: true }),
        }),
      ).text,
    ).toBe("✓ Pull-up — 1 × 5 · 15 kg assist · RIR 1 · Tue W5");
    expect(
      echoMessage(view({ ...base, entries: sets({ loadKg: null, reps: 5, rir: 1, clean: true }) }))
        .text,
    ).toBe("✓ Pull-up — 1 × 5 · bodyweight · RIR 1 · Tue W5");
  });

  it("HSPU shows its step", () => {
    const m = echoMessage(
      view({
        name: "HSPU",
        type: "skill_ladder",
        loadBasis: null,
        hspuStep: "Wall HSPU",
        entries: sets({ loadKg: null, reps: 3, rir: 1, clean: true }),
      }),
    );
    expect(m.text).toBe("✓ HSPU (Wall HSPU) — 1 × 3 · RIR 1 · Tue W5");
  });

  it("make-up and extra", () => {
    expect(
      echoMessage(view({ place: { kind: "makeup", weekday: "mon", date: "2026-10-26" } })).text,
    ).toContain("Monday's session (26 Oct)");
    expect(echoMessage(view({ place: { kind: "extra" } })).text).toContain("· extra");
  });

  it("asks RIR when the last set has none", () => {
    const m = echoMessage(view({ entries: sets({ rir: null }, { rir: null }) }));
    expect(render(m)).toMatchSnapshot();
  });

  it("asks RIR for a planned RIR target even on a bodyweight exercise", () => {
    const m = echoMessage(
      view({
        type: "bodyweight_reps",
        loadBasis: null,
        hasRirTarget: true,
        entries: sets({ loadKg: null, rir: null }),
      }),
    );
    expect(m.keyboard).toHaveLength(2);
    const none = echoMessage(
      view({
        type: "bodyweight_reps",
        loadBasis: null,
        entries: sets({ loadKg: null, rir: null }),
      }),
    );
    expect(none.keyboard).toHaveLength(1);
  });

  it("asks clean for pull-ups and HSPU", () => {
    const m = echoMessage(
      view({
        name: "Pull-up",
        type: "bodyweight_plus",
        loadBasis: "bodyweight_plus",
        needsClean: true,
        entries: sets({ loadKg: null, addedKg: 10, rir: 1, clean: null }),
      }),
    );
    expect(render(m)).toMatchSnapshot();
  });

  it("asks both RIR and clean", () => {
    const m = echoMessage(
      view({
        name: "Pull-up",
        type: "bodyweight_plus",
        loadBasis: "bodyweight_plus",
        needsClean: true,
        entries: sets({ loadKg: null, addedKg: 10, rir: null, clean: null }),
      }),
    );
    expect(render(m)).toMatchSnapshot();
  });

  it("escapes user text", () => {
    expect(echoMessage(view({ name: "A <b> & c" })).text).toContain("A &lt;b&gt; &amp; c");
  });
});

describe("edit and delete", () => {
  const edit = (): Extract<StagedAction, { kind: "edit_group" }> => {
    const before = snapshot({
      exercise: { ...snapshot().exercise, name: "Bench" },
      entries: sets({ reps: 6, loadKg: 55 }, { reps: 6, loadKg: 55 }),
    });
    const after = snapshot({
      exercise: before.exercise,
      entries: sets({ reps: 6, loadKg: 57.5 }, { reps: 6, loadKg: 57.5 }),
    });
    return {
      kind: "edit_group",
      input: editInput({ load_kg: 57.5 }),
      before,
      after,
      setIndexes: [1, 2],
      lastSession: null,
    };
  };

  it("edit echo with undo", () => {
    const m = editEchoMessage(edit(), "u:123", 0);
    expect(m.text).toBe("Changed: Bench sets 1–2 55 → 57.5 kg");
    expect(m.keyboard).toEqual([[{ text: "Undo", data: "ue:u:123:0" }]]);
  });

  it("edit of one set and of reps", () => {
    const a = edit();
    a.setIndexes = [2];
    a.after = { ...a.after, entries: sets({ reps: 6, loadKg: 55 }, { reps: 8, loadKg: 57.5 }) };
    expect(editEchoMessage(a, "p:4", 1).text).toBe("Changed: Bench set 2 6 → 8 reps, 55 → 57.5 kg");
  });

  it("removed text", () => {
    expect(removedText(snapshot())).toBe("Removed: Squat 2 × 8 · 60 kg");
  });

  it("delete question", () => {
    const s = snapshot({ performedAt: "2026-10-27T16:42:00Z" });
    const now = new Date("2026-10-27T18:00:00Z");
    const m = deleteQuestion(s, 9, now);
    expect(m.text).toBe("Remove Squat 2 × 8 · 60 kg (today 17:42)?");
    expect(m.keyboard[0]?.map((b) => b.data)).toEqual(["pa:9:ok", "pa:9:no"]);
    expect(deleteQuestion(s, 9, new Date("2026-10-29T10:00:00Z")).text).toContain(
      "(Tue 27 Oct 17:42)",
    );
  });
});

describe("delete question for a make-up", () => {
  it("shows the session date when it differs from the day it was logged", () => {
    const s = snapshot({ sessionDate: "2026-10-16", performedAt: "2026-10-18T09:09:00Z" });
    const m = deleteQuestion(s, 9, new Date("2026-10-18T10:00:00Z"));
    expect(m.text).toBe("Remove Squat 2 × 8 · 60 kg (Fri 16 Oct, logged today 11:09)?");
  });
});

describe("cancelled and replaced cards", () => {
  it("keep the summary; a clarify-only request keeps the plain text", () => {
    const del: StagedAction = { kind: "delete_group", snapshot: snapshot() };
    expect(cancelledText([del])).toBe("Cancelled, nothing saved: remove Squat 2 × 8 · 60 kg");
    expect(replacedText([del])).toBe("Replaced by a newer request: remove Squat 2 × 8 · 60 kg");
    const clarify: StagedAction = {
      kind: "clarify_exercise",
      input: logInput(),
      said: "x",
      candidates: [],
    };
    expect(cancelledText([clarify])).toBe("Cancelled, nothing saved.");
    expect(replacedText([clarify])).toBe("Replaced by a newer request.");
  });
});

describe("stripMarkdown", () => {
  it("drops bold, underline, headings and backticks", () => {
    expect(stripMarkdown("**Log sets:**\n## Plan\n  # x\n`a` and __b__")).toBe(
      "Log sets:\nPlan\nx\na and b",
    );
  });
});

describe("cards", () => {
  it("reasons are not repeated for several make-ups of one day", () => {
    const item = {
      id: 1,
      subItem: 0,
      week: 5,
      weekday: "fri" as const,
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
    const mk = () => logAction({ match: "makeup", plannedItem: item, sessionDate: "2026-10-16" });
    expect(reasonPhrases([mk(), mk(), mk()], ["multiple_writes", "makeup"])).toEqual([
      "more than one change",
      "Friday's session (16 Oct)",
    ]);
  });

  it("confirm card with every reason", () => {
    const a = logAction({
      match: "makeup",
      plannedItem: {
        id: 1,
        subItem: 0,
        week: 5,
        weekday: "mon",
        planName: "Squat",
        priority: "High",
        setsMin: 3,
        setsMax: 3,
        repsMin: 6,
        repsMax: 8,
        rirMin: null,
        rirMax: null,
        isDeload: false,
      },
      sessionDate: "2026-10-26",
      entries: sets({ reps: 50, loadKg: 600 }),
      missingFields: ["load"],
      guessedFields: ["sets"],
      needsConfirmation: true,
    });
    const un = logAction({ match: "unplanned" });
    const d = decidePolicy([a, un]);
    if (d.mode !== "confirm") throw new Error("expected confirm");
    const reasons: string[] = [...d.reasons];
    expect(reasons).toEqual(
      expect.arrayContaining([
        "multiple_writes",
        "not_in_today",
        "makeup",
        "missing_field",
        "guessed",
        "model_flag",
        "load_far_off",
        "reps_far_off",
      ]),
    );
    expect(reasonPhrases([a, un], reasons)).toEqual([
      "more than one change",
      "Monday's session (26 Oct)",
      "missing: load",
      "sets were guessed",
      "I wasn't sure",
      "far from last time: 600 kg vs 60 kg last time",
      "reps look high: 50",
      "not in today's session",
    ]);
    expect(
      render(confirmCard({ id: 3, kind: "confirm", actions: [a, un], reasons })),
    ).toMatchSnapshot();
  });

  it("replaced notice and delete card", () => {
    const del: StagedAction = { kind: "delete_group", snapshot: snapshot() };
    const m = confirmCard({
      id: 4,
      kind: "delete",
      actions: [del],
      reasons: ["delete"],
      replacedSummary: "Bench 2 × 6 · 55 kg",
    });
    expect(render(m)).toMatchSnapshot();
    expect(m.keyboard[0]).toHaveLength(2);
  });

  it("confirmCard shows the heard line first", () => {
    const a = logAction();
    const m = confirmCard({
      id: 5,
      kind: "confirm",
      actions: [a],
      reasons: ["voice_input"],
      heard: "fifteen face pulls",
    });
    expect(m.text.startsWith("🎤 heard: fifteen face pulls\n\nSave this?")).toBe(true);
    expect(m.text).toContain("Why I'm asking: from a voice note");
    const long = confirmCard({
      id: 5,
      kind: "confirm",
      actions: [a],
      reasons: [],
      heard: "x".repeat(400),
    });
    expect(long.text.split("\n")[0]).toBe(`🎤 heard: ${"x".repeat(300)}…`);
    const esc = confirmCard({ id: 5, kind: "confirm", actions: [a], reasons: [], heard: "a < b" });
    expect(esc.text.split("\n")[0]).toBe("🎤 heard: a &lt; b");
  });

  it("clarifyCard shows the heard line first", () => {
    const m = clarifyCard({
      id: 8,
      actionIndex: 0,
      said: "fp",
      candidates: [{ slug: "face_pull", name: "Face pull" }],
      replacedSummary: "Bench",
      heard: "fp two by fifteen",
    });
    expect(m.text.startsWith("🎤 heard: fp two by fifteen\n\nReplaces: Bench")).toBe(true);
  });

  it("clarify message", () => {
    const m = clarifyCard({
      id: 8,
      actionIndex: 0,
      said: "fp",
      candidates: [
        { slug: "face_pull", name: "Face pull" },
        { slug: "front_raise", name: "Front raise" },
      ],
    });
    expect(render(m)).toMatchSnapshot();
  });

  it("memory list", () => {
    const m = memoryList([
      {
        id: 5,
        kind: "alias",
        content: '"fp" = Face pull',
        structured: null,
        confirmed: true,
        active: true,
        createdAt: new Date(),
      },
    ]);
    expect(render(m)).toMatchSnapshot();
    expect(memoryList([]).text).toBe("I don't know anything about you yet.");
  });
});

describe("HTML-safe constants", () => {
  const ALLOWED = new Set([
    "b",
    "strong",
    "i",
    "em",
    "u",
    "ins",
    "s",
    "strike",
    "del",
    "a",
    "code",
    "pre",
    "tg-spoiler",
    "blockquote",
    "span",
  ]);
  const texts = {
    HELP_TEXT,
    HISTORY_USAGE,
    HISTORY_UNKNOWN,
    SESSION_USAGE,
    NUMBER_GUARD_FALLBACK,
    TEXT_ONLY,
    UNKNOWN_COMMAND,
    NO_AI_KEY,
    BUDGET_DAY: budgetReachedText("day", 200_000, new Date("2026-10-18T10:00:00Z")),
    DIDNT_GET_IT,
    EXPIRED,
    STALE,
    MEMORY_EMPTY,
  };
  for (const [name, value] of Object.entries(texts)) {
    it(`${name} has only allowed tags and no bare < or &`, () => {
      for (const m of value.matchAll(/<\/?([a-zA-Z][\w-]*)/g)) {
        expect(ALLOWED.has((m[1] as string).toLowerCase())).toBe(true);
      }
      expect(value.replace(/<[^>]*>/g, "")).not.toMatch(/[<>]/);
      expect(value.replace(/&(?:amp|lt|gt|quot|#\d+);/g, "")).not.toContain("&");
    });
  }
});

describe("memory card", () => {
  it("explains a memory-only card", () => {
    const a: StagedAction = {
      kind: "save_memory",
      input: { kind: "limitation", content: "no dips" },
    };
    expect(reasonPhrases([a], ["memory"])).toEqual(["new memory item"]);
  });
});

describe("skip texts", () => {
  const skipAct = (priority: "High" | "PRIMARY", whole = false): StagedAction => ({
    kind: "skip_items",
    sessionDate: "2026-10-19",
    whole,
    items: [
      { plannedItemId: 1, planName: "Bulgarian split squat", priority },
      ...(whole ? [{ plannedItemId: 2, planName: "Row <x>", priority: "High" as const }] : []),
    ],
  });

  it("the confirm card asks 'Skip this?' with the item and why", () => {
    const m = confirmCard({
      id: 4,
      kind: "confirm",
      actions: [skipAct("PRIMARY")],
      reasons: ["skip_primary"],
    });
    expect(m.text).toBe(
      "Skip this?\n• Bulgarian split squat (PRIMARY)\n\nWhy I'm asking: skipping a PRIMARY item",
    );
    expect(m.keyboard[0]?.map((b) => b.data)).toEqual(["pa:4:ok", "pa:4:ed", "pa:4:no"]);
  });

  it("the whole-session card lists every item, escaped", () => {
    const m = confirmCard({
      id: 4,
      kind: "confirm",
      actions: [skipAct("High", true)],
      reasons: ["skip_session"],
    });
    expect(m.text).toContain("• Whole session (Mon 19 Oct): Bulgarian split squat, Row &lt;x&gt;");
    expect(m.text).toContain("skipping the whole session");
  });

  it("a mixed request keeps 'Save this?'", () => {
    const m = confirmCard({
      id: 4,
      kind: "confirm",
      actions: [skipAct("PRIMARY"), logAction()],
      reasons: ["multiple_writes"],
    });
    expect(m.text.startsWith("Save this?")).toBe(true);
  });

  it("list, echo and undone texts", () => {
    const list = skipList("2026-10-19", [
      { plannedItemId: 5, planName: "Squat", priority: "PRIMARY" },
      { plannedItemId: 6, planName: "Curl", priority: "Low" },
    ]);
    expect(list.text).toBe("Skip what? (Mon 19 Oct)");
    expect(list.keyboard.flat()).toEqual([
      { text: "⭐ Squat", data: "sk:20261019:5" },
      { text: "Curl", data: "sk:20261019:6" },
      { text: "Whole session", data: "sk:20261019:all" },
    ]);
    const item = (planName: string) => ({ plannedItemId: 1, planName, before: null });
    const one = skipEcho(
      { kind: "skip", sessionDate: "2026-10-19", whole: false, items: [item("A")] },
      "u:9",
      0,
    );
    expect(one).toEqual({
      text: "Skipped: A",
      keyboard: [[{ text: "Undo", data: "us:u:9:0" }]],
    });
    const all = skipEcho(
      { kind: "skip", sessionDate: "2026-10-19", whole: true, items: [item("A"), item("B")] },
      "p:3",
      0,
    );
    expect(all.text).toBe("Skipped the whole session (Mon 19 Oct): A, B");
    expect(
      skipEcho({ kind: "skip", sessionDate: "2026-10-19", whole: false, items: [] }, "u:9", 0),
    ).toEqual({ text: "Nothing skipped: already done or skipped.", keyboard: [] });
    expect(skipUndone(["A", "B"])).toEqual({ text: "Skip undone: A, B", keyboard: [] });
  });

  it("falls back to the plan name for a ledger row without a label", () => {
    const legacy = {
      kind: "skip" as const,
      sessionDate: "2026-10-19",
      whole: false,
      items: [{ plannedItemId: 5, planName: "Squat", before: null }],
    };
    expect(skipEcho(legacy, "u:9", 0).text).toBe("Skipped: Squat");
    expect(
      skipList("2026-10-19", [{ plannedItemId: 5, planName: "Squat", priority: "Low" }])
        .keyboard[0],
    ).toEqual([{ text: "Squat", data: "sk:20261019:5" }]);
  });

  it("uses the /today label when there is one", () => {
    const list = skipList("2026-10-19", [
      { plannedItemId: 5, planName: "Chest-supported row", label: "Ring row", priority: "Low" },
    ]);
    expect(list.keyboard[0]).toEqual([{ text: "Ring row", data: "sk:20261019:5" }]);
    const echo = skipEcho(
      {
        kind: "skip",
        sessionDate: "2026-10-19",
        whole: false,
        items: [
          { plannedItemId: 5, planName: "Chest-supported row", label: "Ring row", before: null },
        ],
      },
      "u:9",
      0,
    );
    expect(echo.text).toBe("Skipped: Ring row");
  });

  it("explains an ambiguous skip", () => {
    expect(reasonPhrases([skipAct("High")], ["skip_ambiguous"])).toEqual([
      "more than one planned item matches",
    ]);
  });

  it("help lists /skip", () => {
    expect(HELP_TEXT).toContain("/skip");
  });
});

describe("heardLine", () => {
  it("cuts by code points, never inside an emoji", () => {
    const text = `${"a".repeat(299)}😀tail`;
    const line = heardLine(text);
    expect(line).toBe(`🎤 heard: ${"a".repeat(299)}😀…`);
  });
});

describe("classMovesCard", () => {
  const action: Extract<StagedAction, { kind: "log_class" }> = {
    kind: "log_class",
    date: "2026-10-01",
    input: {
      moves: [
        { name: "Pistol", sets: 5, reps: 10, groups: ["legs"] },
        { name: "Pull-up", sets: 4, reps: 8, groups: ["pull"] },
        { name: "Burpee", sets: 1, groups: ["legs", "push"] },
      ],
    },
  };

  it("shows breakdown, nothing ticked at mask 0", () => {
    const m = classMovesCard({ id: 9, action, mask: 0, heard: "pistols and pull-ups" });
    expect(m.text).toContain("🎤 heard: pistols and pull-ups");
    expect(m.text).toContain("Thursday class (Thu 1 Oct):");
    expect(m.text).toContain("Legs: 2 moves, 6 sets");
    expect(m.text).toContain("Pull: 1 move, 4 sets");
    expect(m.text).toContain("Push: 1 move, 1 set");
    expect(m.text).toContain("Which parts were heavy?");
    expect(m.keyboard.flat().some((b) => b.text.includes("✓"))).toBe(false);
    expect(m.keyboard[0]?.map((b) => b.data)).toEqual(["cm:9:1", "cm:9:2", "cm:9:4"]);
    expect(m.keyboard[1]?.map((b) => b.data)).toEqual(["cm:9:0:ok", "cm:9:0:ok", "pa:9:no"]);
  });

  it("never invents sets", () => {
    const some = {
      ...action,
      input: {
        moves: [
          { name: "Pistol", sets: 5, groups: ["legs" as const] },
          { name: "Burpee", groups: ["legs" as const] },
          { name: "Pull-up", groups: ["pull" as const] },
        ],
      },
    };
    const m = classMovesCard({ id: 9, action: some, mask: 0 });
    expect(m.text).toContain("Legs: 2 moves, 5+ sets");
    expect(m.text).toContain("Pull: 1 move\n");
  });

  it("Not heavy saves in one tap", () => {
    const m = classMovesCard({ id: 9, action, mask: 5 });
    expect(m.keyboard[1]?.[0]).toEqual({ text: "Not heavy", data: "cm:9:0:ok" });
  });

  it("a class with moves in a multi-action card states heavy groups", () => {
    const line = (heavy: ("legs" | "pull" | "push")[]) =>
      confirmCard({
        id: 1,
        kind: "confirm",
        actions: [
          { ...action, input: { ...action.input, heavy_groups: heavy } },
          { kind: "log_bodyweight", input: { kg: 70 }, date: "2026-10-01" },
        ],
        reasons: ["multiple_writes", "class_moves"],
      }).text;
    expect(line([])).toContain("Thursday class: 3 moves; heavy: none");
    expect(line(["legs"])).toContain("Thursday class: 3 moves; heavy: legs");
    expect(line([])).toContain("class report");
    expect(line([])).not.toContain("you pick");
  });

  it("ticks the selected groups", () => {
    const m = classMovesCard({ id: 9, action, mask: 5 });
    expect(m.keyboard[0]?.map((b) => b.text)).toEqual(["✓ Pull", "Push", "✓ Legs"]);
    expect(m.keyboard[0]?.map((b) => b.data)).toEqual(["cm:9:4", "cm:9:7", "cm:9:1"]);
    expect(m.keyboard[1]?.[1]?.data).toBe("cm:9:5:ok");
  });
});

describe("budget texts", () => {
  it("day", () => {
    expect(budgetReachedText("day", 200_000, new Date("2026-10-18T10:00:00Z"))).toBe(
      "AI daily budget reached (200,000 tokens). Resets at midnight (Rome). Commands still work.",
    );
  });
  it("month", () => {
    expect(budgetReachedText("month", 3_000_000, new Date("2026-10-18T10:00:00Z"))).toBe(
      "AI monthly budget reached (3,000,000 tokens). Resets on 1 Nov. Commands still work.",
    );
  });
  it("month uses the Rome date at year end", () => {
    expect(budgetReachedText("month", 3_000_000, new Date("2026-12-31T22:30:00Z"))).toContain(
      "Resets on 1 Jan.",
    );
  });
  it("voice never shows used above the cap", () => {
    expect(voiceBudgetText(1800, 1800)).toBe(
      "Voice budget reached (30 of 30 min today). Resets at midnight (Rome). Typing still works.",
    );
    expect(voiceBudgetText(1790, 1800)).toContain("30 of 30 min");
    expect(voiceBudgetText(600, 1800)).toContain("10 of 30 min");
  });
});
