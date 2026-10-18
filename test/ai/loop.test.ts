import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeModel, text, toolUse } from "../../src/ai/fake-model.js";
import { runIntent } from "../../src/ai/loop.js";
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
      Array.from({ length: 5 }, () => [toolUse("log_sets", logSets("x"))]),
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
      async totals() {
        const total = recorded.reduce((a, b) => a + b, 0);
        return { day: total, month: total };
      },
      async record(u: { inputTokens: number; outputTokens: number }) {
        recorded.push(u.inputTokens + u.outputTokens);
      },
    };
    const backend = fakeBackend();
    const res = await runIntent({ ...base, model, backend, usage });
    expect(res).toEqual({ kind: "budget_reached" });
    expect(model.requests).toHaveLength(1);
    expect(backend.calls).toEqual(["log_sets:bench"]);
  });

  it.each([
    ["day", { day: 1000, month: 0 }],
    ["month", { day: 0, month: 10000 }],
  ])("blocks the model call at the %s cap", async (_n, totals) => {
    const model = createFakeModel([[text("x")]]);
    const res = await runIntent({
      ...base,
      model,
      backend: fakeBackend(),
      usage: fakeUsage(totals),
    });
    expect(res).toEqual({ kind: "budget_reached" });
    expect(model.requests).toHaveLength(0);
  });
});
