import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeModel, text, toolUse } from "../../src/ai/fake-model.js";
import { countUnresolvedErrors, type IntentEvent, runIntent } from "../../src/ai/loop.js";
import { summarize } from "../../src/bot/log-format.js";
import { decidePolicy } from "../../src/logging/policy.js";
import type {
  GroupSnapshot,
  LoggingBackend,
  ResolvedSwap,
  SwapExerciseInput,
} from "../../src/logging/types.js";
import { fakeBackend, fakeUsage, promptContext, promptStatic } from "./helpers.js";

const base = {
  text: "hi",
  promptStatic,
  promptContext,
  now: new Date("2026-10-27T10:00:00Z"),
  dailyTokenCap: 1000,
  monthlyTokenCap: 10000,
};
const logSets = (said: string) => ({
  exercise: { said },
  sets: { count: 3, reps: 8, load_kg: 60 },
});

afterEach(() => vi.useRealTimers());

describe("runIntent", () => {
  it("stages two log_sets from one turn in order and records usage per call", async () => {
    const model = createFakeModel([
      [toolUse("log_sets", logSets("bench")), toolUse("log_sets", logSets("lateral"))],
      [text("done")],
    ]);
    const usage = fakeUsage();
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.staged.map((s) => (s.kind === "clarify_exercise" ? s.said : ""))).toEqual([
      "bench",
      "lateral",
    ]);
    expect(res.turns).toBe(2);
    expect(res.replyText).toBe("done");
    expect(usage.recorded).toHaveLength(2);
    expect(usage.recorded[0]?.model).toBe("fake-model");
  });

  it("returns null replyText when only tools were used", async () => {
    const model = createFakeModel([[toolUse("log_sets", logSets("x"))], []]);
    const res = await runIntent({ ...base, model, backend: fakeBackend(), usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", replyText: null });
  });

  it("sends invalid input back as is_error and spends a turn", async () => {
    const model = createFakeModel([
      [toolUse("log_sets", { exercise: { said: "squat" }, sets: [] })],
      [text("sorry")],
    ]);
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", staged: [], turns: 2, toolErrors: 1 });
    expect(backend.calls).toEqual([]);
    const last = model.messageSnapshots[1]?.at(-1);
    const block = Array.isArray(last?.content) ? last.content[0] : undefined;
    expect(block).toMatchObject({ type: "tool_result", is_error: true });
    expect(JSON.stringify(block)).toContain("sets");
  });

  it("stops at the turn cap and returns what was staged", async () => {
    const model = createFakeModel(
      Array.from({ length: 5 }, (_, i) => [toolUse("log_sets", logSets(`ex${i}`))]),
    );
    const res = await runIntent({
      ...base,
      model,
      backend: fakeBackend(),
      usage: fakeUsage(),
      maxTurns: 3,
    });
    expect(res).toMatchObject({ kind: "ok", replyText: null, turns: 3 });
    if (res.kind === "ok") expect(res.staged).toHaveLength(3);
    expect(model.requests).toHaveLength(3);
  });

  describe("a retried log_sets", () => {
    const run = async (turns: Parameters<typeof createFakeModel>[0]) => {
      const res = await runIntent({
        ...base,
        model: createFakeModel(turns),
        backend: fakeBackend(),
        usage: fakeUsage(),
      });
      if (res.kind !== "ok") throw new Error("expected ok");
      return res;
    };
    const saidOf = (a: { kind: string; said?: string }) => a.said;

    it("replaces the earlier turn's staged log of the same exercise, in place", async () => {
      const res = await run([
        [toolUse("log_sets", logSets("lateral"))],
        [toolUse("log_sets", logSets("split squat"))],
        [toolUse("log_sets", { ...logSets("split squat"), day: "today" })],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(2);
      expect(res.staged.map((a) => saidOf(a as never))).toEqual(["lateral", "split squat"]);
      const second = res.staged[1];
      expect(second?.kind === "clarify_exercise" && second.input.day).toBe("today");
    });

    it("drops an exact duplicate in the same turn and keeps different inputs", async () => {
      const res = await run([
        [
          toolUse("log_sets", logSets("bench")),
          toolUse("log_sets", logSets("bench")),
          toolUse("log_sets", { ...logSets("bench"), rir: 2 }),
        ],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(2);
    });

    it("replaces every earlier-turn call for the exercise with the one retry", async () => {
      const res = await run([
        [
          toolUse("log_sets", logSets("bench")),
          toolUse("log_sets", { ...logSets("bench"), rir: 2 }),
        ],
        [toolUse("log_sets", { ...logSets("bench"), day: "today" })],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(1);
    });

    it("counts a fixed tool error from the replacing turn", async () => {
      const res = await run([
        [toolUse("log_sets", { exercise: { said: "squat" }, sets: [] })],
        [toolUse("log_sets", logSets("squat"))],
        [toolUse("log_sets", { ...logSets("squat"), day: "today" })],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(1);
      expect(res.toolErrors).toBe(0);
    });
  });

  it("throws when the budget aborts a slow call", async () => {
    vi.useFakeTimers();
    const model = createFakeModel([{ content: [text("late")], delayMs: 60_000 }]);
    const p = runIntent({
      ...base,
      model,
      backend: fakeBackend(),
      usage: fakeUsage(),
      budgetMs: 1000,
    });
    const assertion = expect(p).rejects.toThrow(/budget/i);
    await vi.advanceTimersByTimeAsync(1100);
    await assertion;
  });

  it("stops with budget_reached when the cap is hit mid-loop, even with actions staged (m7)", async () => {
    const model = createFakeModel([
      { content: [toolUse("log_sets", logSets("bench"))], inputTokens: 600, outputTokens: 500 },
      [toolUse("log_sets", logSets("lateral"))],
      [text("done")],
    ]);
    const recorded: number[] = [];
    const usage = {
      async weekTotals() {
        return { tokens: 0, sttSeconds: 0 };
      },
      async totals() {
        const total = recorded.reduce((a, b) => a + b, 0);
        return { day: total, month: total };
      },
      async record(u: { inputTokens: number; outputTokens: number }) {
        recorded.push(u.inputTokens + u.outputTokens);
      },
      async sttSecondsToday() {
        return 0;
      },
      async recordStt() {},
    };
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage });
    expect(res).toEqual({ kind: "budget_reached", cap: "day" });
    expect(model.requests).toHaveLength(1);
    expect(backend.calls).toEqual(["log_sets:bench"]);
  });

  it.each([
    ["day", { day: 1000, month: 0 }],
    ["month", { day: 0, month: 10000 }],
  ])("blocks the model call at the %s cap and carries it", async (cap, totals) => {
    const model = createFakeModel([[text("x")]]);
    const res = await runIntent({
      ...base,
      model,
      backend: fakeBackend(),
      usage: fakeUsage(totals),
    });
    expect(res).toEqual({ kind: "budget_reached", cap });
    expect(model.requests).toHaveLength(0);
  });
});

describe("unresolved tool errors", () => {
  const err = (
    turn: number,
    tool: string,
    said: string | null = null,
    slug: string | null = null,
  ): IntentEvent => ({ type: "error", turn, tool, said, slug });
  const staged = (
    turn: number,
    kind: Extract<IntentEvent, { type: "staged" }>["kind"],
    said: string | null = null,
    slug: string | null = null,
  ): IntentEvent => ({ type: "staged", turn, kind, said, slug });

  it("counts an error nobody fixed, not one retried in a later turn", () => {
    expect(
      countUnresolvedErrors([
        err(1, "log_sets", "bench"),
        staged(2, "log_sets", "bench", "bench_press"),
      ]),
    ).toBe(0);
    expect(countUnresolvedErrors([err(1, "log_sets", "bench")])).toBe(1);
    expect(
      countUnresolvedErrors([
        err(1, "log_sets", "x", "squat"),
        staged(2, "log_sets", "squat", "squat"),
      ]),
    ).toBe(0);
    expect(
      countUnresolvedErrors([
        err(1, "log_sets", "lunges"),
        staged(2, "log_sets", "squats", "squat"),
      ]),
    ).toBe(1);
    expect(
      countUnresolvedErrors([err(1, "log_sets", "sq"), staged(2, "clarify_exercise", "sq")]),
    ).toBe(0);
  });

  it("a second group staged in the same turn never fixes the error", () => {
    expect(
      countUnresolvedErrors([
        err(1, "log_sets", "bench"),
        staged(1, "log_sets", "bench", "bench_press"),
      ]),
    ).toBe(1);
  });

  it("an edit or undo error is fixed only by a later edit or delete, never by a log", () => {
    expect(
      countUnresolvedErrors([err(1, "edit_last_entry"), staged(1, "log_sets", "squats", "squat")]),
    ).toBe(1);
    expect(
      countUnresolvedErrors([err(1, "edit_last_entry"), staged(2, "log_sets", "squats", "squat")]),
    ).toBe(1);
    expect(countUnresolvedErrors([err(1, "edit_last_entry"), staged(2, "edit_group")])).toBe(0);
    expect(countUnresolvedErrors([err(1, "undo_last_entry"), staged(2, "delete_group")])).toBe(0);
    expect(countUnresolvedErrors([err(1, "undo_last_entry"), staged(1, "delete_group")])).toBe(1);
  });

  it("a failed swap_exercise stays unresolved unless a later swap is staged", () => {
    expect(countUnresolvedErrors([err(1, "swap_exercise")])).toBe(1);
    expect(countUnresolvedErrors([err(1, "swap_exercise"), staged(2, "log_sets", "x", "y")])).toBe(
      1,
    );
    expect(countUnresolvedErrors([err(1, "swap_exercise"), staged(1, "swap")])).toBe(1);
    expect(countUnresolvedErrors([err(1, "swap_exercise"), staged(2, "swap")])).toBe(0);
  });

  it("an unknown tool name is fixed by any later staged action", () => {
    expect(countUnresolvedErrors([err(1, "log_set"), staged(2, "log_sets", "bench")])).toBe(0);
    expect(countUnresolvedErrors([err(1, "log_set"), staged(1, "log_sets", "bench")])).toBe(1);
    expect(countUnresolvedErrors([err(1, "log_set")])).toBe(1);
  });

  it("the loop: two bench groups in one turn, the first errors, nothing retried", async () => {
    const model = createFakeModel([
      [
        toolUse("log_sets", { exercise: { said: "bench" }, sets: [] }),
        toolUse("log_sets", logSets("bench")),
      ],
      [text("done")],
    ]);
    const res = await runIntent({ ...base, model, backend: fakeBackend(), usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", toolErrors: 1 });
  });

  it("the loop: a failed edit next to a new log is unresolved", async () => {
    const model = createFakeModel([
      [
        toolUse("edit_last_entry", {
          changes: { reps: 8 },
          guessed_fields: [],
          needs_confirmation: false,
        }),
        toolUse("log_sets", logSets("squats")),
      ],
      [text("done")],
    ]);
    const res = await runIntent({ ...base, model, backend: fakeBackend(), usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", toolErrors: 1 });
  });

  it("the loop reports unresolved errors and a retried one as zero", async () => {
    const bad = { exercise: { said: "bench" }, sets: [] };
    const model = createFakeModel([
      [toolUse("log_sets", bad)],
      [toolUse("log_sets", logSets("bench"))],
      [text("done")],
    ]);
    const res = await runIntent({ ...base, model, backend: fakeBackend(), usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", toolErrors: 0, truncated: false });
  });

  it("a max_tokens turn executes none of its tool calls and is flagged", async () => {
    const model = createFakeModel([
      [toolUse("log_sets", logSets("bench"))],
      { content: [toolUse("log_sets", logSets("lateral"))], stopReason: "max_tokens" },
    ]);
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", truncated: true });
    if (res.kind === "ok") expect(res.staged).toHaveLength(1);
    expect(backend.calls).toEqual(["log_sets:bench"]);
  });

  it("collects read results in order and read errors never count as tool errors", async () => {
    const model = createFakeModel([
      [
        toolUse("get_session", { day: "mon", date: "2026-10-26" }),
        toolUse("get_exercise_history", { exercise: { said: "squat" } }),
        toolUse("get_alternatives", { exercise: { said: "fp" } }),
      ],
      [text("ok")],
    ]);
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", toolErrors: 0, staged: [] });
    if (res.kind !== "ok") return;
    expect(res.reads).toEqual([
      {
        tool: "get_exercise_history",
        content: JSON.stringify({ found: true, sessions: [] }),
        fallbackHtml: "<b>History</b>",
      },
      { tool: "get_alternatives", content: JSON.stringify({ found: true }), fallbackHtml: null },
    ]);
  });

  it("a staged save_memory is not an error and a bad one is only fixed by another save_memory", async () => {
    const model = createFakeModel([
      [toolUse("save_memory", { kind: "limitation", content: "left shoulder" })],
      [text("")],
    ]);
    const res = await runIntent({ ...base, model, backend: fakeBackend(), usage: fakeUsage() });
    expect(res).toMatchObject({ kind: "ok", toolErrors: 0 });
    if (res.kind === "ok") expect(res.staged.map((s) => s.kind)).toEqual(["save_memory"]);
    const events: IntentEvent[] = [
      { type: "error", turn: 1, tool: "save_memory", said: null, slug: null },
      { type: "staged", turn: 2, said: "x", slug: null, kind: "log_sets" },
    ];
    expect(countUnresolvedErrors(events)).toBe(1);
  });

  describe("repeated swap_exercise calls", () => {
    const swapInput = (extra: object = {}, from = "Romanian deadlift", to = "good mornings") => ({
      exercise: { said: from },
      replacement: { said: to },
      scope: "today",
      ...extra,
    });
    const idOf = (said: string) => [...said].reduce((n, c) => n + c.charCodeAt(0), 0);
    const resolvedSwap = (i: SwapExerciseInput): ResolvedSwap =>
      ({
        from: { id: idOf(i.exercise.said), name: i.exercise.said },
        to: {
          id: idOf(i.replacement.said),
          name: i.replacement.said,
          slug: i.replacement.said,
          isNew: false,
          newSpec: null,
        },
        referenceDate: "2026-10-19",
        scope: i.scope ?? null,
        days: null,
        referenceWeekday: "mon",
        futureWeekdays: [],
        todayItemIds: [88],
        loggedOnReference: false,
        affectedSessions: 0,
        sessionsByWeekday: {},
        prescription: "2 × 6",
      }) as ResolvedSwap;
    const swapBackend = () => {
      const backend = fakeBackend();
      backend.stageSwap = async (i: SwapExerciseInput) => ({
        ok: true,
        action: { kind: "swap", input: i, resolved: resolvedSwap(i) },
        preview: "Staged a plan change.",
      });
      return backend;
    };
    const run = async (script: Parameters<typeof createFakeModel>[0], backend = swapBackend()) => {
      const res = await runIntent({
        ...base,
        model: createFakeModel(script),
        backend,
        usage: fakeUsage(),
      });
      if (res.kind !== "ok") throw new Error("not ok");
      return res;
    };

    it("collapses identical resolved swaps (cosmetic input differences) into one", async () => {
      const model = createFakeModel([
        [
          toolUse("swap_exercise", swapInput({ day: "today" })),
          toolUse("swap_exercise", swapInput()),
        ],
        [toolUse("swap_exercise", swapInput({ day: "today" }))],
        [text("ok")],
      ]);
      const res = await runIntent({ ...base, model, backend: swapBackend(), usage: fakeUsage() });
      if (res.kind !== "ok") throw new Error("not ok");
      expect(res.staged).toHaveLength(1);
      const decision = decidePolicy(res.staged);
      expect(decision).toMatchObject({ mode: "confirm" });
      if (decision.mode === "confirm") {
        expect(decision.reasons).not.toContain("multiple_writes");
        expect(decision.reasons).toContain("plan_change");
      }
      expect(summarize(res.staged).split(";")).toHaveLength(1);
    });

    it("keeps two different swaps as two lines", async () => {
      const model = createFakeModel([
        [
          toolUse("swap_exercise", swapInput()),
          toolUse("swap_exercise", swapInput({}, "Squat", "leg press")),
        ],
        [text("ok")],
      ]);
      const res = await runIntent({ ...base, model, backend: swapBackend(), usage: fakeUsage() });
      if (res.kind !== "ok") throw new Error("not ok");
      expect(res.staged).toHaveLength(2);
      expect(summarize(res.staged).split(";")).toHaveLength(2);
    });

    it("keeps the same pair for today and for the rest", async () => {
      const res = await run([
        [
          toolUse("swap_exercise", swapInput()),
          toolUse("swap_exercise", swapInput({ scope: "rest" })),
        ],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(2);
    });

    it("keeps the same exercise swapped to two different ones", async () => {
      const res = await run([
        [
          toolUse("swap_exercise", swapInput({}, "Romanian deadlift", "good mornings")),
          toolUse("swap_exercise", swapInput({}, "Romanian deadlift", "leg curl")),
        ],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(2);
    });

    it("keeps two new exercises with the same slug but different specs", async () => {
      const backend = fakeBackend();
      backend.stageSwap = async (i: SwapExerciseInput) => {
        const r = resolvedSwap(i);
        r.to = {
          id: null,
          name: "Thing",
          slug: "thing",
          isNew: true,
          newSpec: {
            type: "weighted",
            loadBasis: i.replacement.said === "a" ? "barbell_total" : "per_hand",
            equipmentSlug: null,
            muscleGroup: "legs",
          },
        };
        return { ok: true, action: { kind: "swap", input: i, resolved: r }, preview: "x" };
      };
      const res = await run(
        [
          [
            toolUse("swap_exercise", swapInput({}, "Romanian deadlift", "a")),
            toolUse("swap_exercise", swapInput({}, "Romanian deadlift", "b")),
          ],
          [text("ok")],
        ],
        backend,
      );
      expect(res.staged).toHaveLength(2);
    });

    it("a dropped retry still fixes an earlier invalid swap", async () => {
      const res = await run([
        [toolUse("swap_exercise", swapInput())],
        [toolUse("swap_exercise", { exercise: { said: "x" } })],
        [toolUse("swap_exercise", swapInput({ day: "today" }))],
        [text("ok")],
      ]);
      expect(res.staged).toHaveLength(1);
      expect(res.swapRefusals).toEqual([]);
      expect(res.toolErrors).toBe(0);
    });
  });

  describe("other deduped actions", () => {
    const snap = (groupId: number) => ({ groupId }) as GroupSnapshot;
    const backendWith = (undoIds: number[]) => {
      const backend = fakeBackend();
      let n = 0;
      backend.stageUndoLast = async () => ({
        ok: true,
        action: { kind: "delete_group", snapshot: snap(undoIds[n++] ?? 0) },
        preview: "Staged removal",
      });
      return backend;
    };
    const run = async (script: Parameters<typeof createFakeModel>[0], backend: LoggingBackend) => {
      const res = await runIntent({
        ...base,
        model: createFakeModel(script),
        backend,
        usage: fakeUsage(),
      });
      if (res.kind !== "ok") throw new Error("not ok");
      return res;
    };

    it("two undo calls on the same group collapse into one removal", async () => {
      const res = await run(
        [[toolUse("undo_last_entry", {}), toolUse("undo_last_entry", {})], [text("ok")]],
        backendWith([5, 5]),
      );
      expect(res.staged).toHaveLength(1);
    });

    it("delete_group of different groups both stay", async () => {
      const res = await run(
        [[toolUse("undo_last_entry", {}), toolUse("undo_last_entry", {})], [text("ok")]],
        backendWith([5, 6]),
      );
      expect(res.staged).toHaveLength(2);
    });

    it("identical save_memory collapses, distinct ones stay", async () => {
      const mem = (content: string) => ({ kind: "limitation", content });
      const same = await run(
        [
          [toolUse("save_memory", mem("bad knee")), toolUse("save_memory", mem("bad knee"))],
          [text("ok")],
        ],
        fakeBackend(),
      );
      expect(same.staged).toHaveLength(1);
      const distinct = await run(
        [
          [toolUse("save_memory", mem("bad knee")), toolUse("save_memory", mem("bad back"))],
          [text("ok")],
        ],
        fakeBackend(),
      );
      expect(distinct.staged).toHaveLength(2);
    });
  });
});
