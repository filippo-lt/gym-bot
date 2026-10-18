import { describe, expect, it } from "vitest";
import {
  cancelledText,
  clarifyCard,
  confirmCard,
  deleteQuestion,
  type EchoView,
  echoMessage,
  editEchoMessage,
  memoryList,
  reasonPhrases,
  removedText,
  replacedText,
  stripMarkdown,
} from "../../src/bot/log-format.js";
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
      "far from last time: 600 kg",
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
