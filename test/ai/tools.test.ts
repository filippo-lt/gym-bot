import { describe, expect, it } from "vitest";
import { buildSystem } from "../../src/ai/prompt.js";
import { executeTool, TOOLS } from "../../src/ai/tools.js";
import { fakeBackend, promptContext, promptStatic } from "./helpers.js";

describe("tool schemas", () => {
  it("has eight tools, each a top-level object schema without $schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "get_session",
      "get_exercise_history",
      "get_alternatives",
      "log_sets",
      "edit_last_entry",
      "undo_last_entry",
      "skip_items",
      "save_memory",
    ]);
    for (const t of TOOLS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema).not.toHaveProperty("$schema");
      expect(t.description?.length).toBeGreaterThan(20);
    }
  });

  it("does not make defaulted fields required", () => {
    const log = TOOLS.find((t) => t.name === "log_sets");
    expect(log?.input_schema.required).toEqual(["exercise", "sets"]);
  });
});

describe("executeTool", () => {
  it("names the bad field in an error", async () => {
    const r = await executeTool("log_sets", { exercise: { said: "x" } }, fakeBackend());
    expect(r.isError).toBe(true);
    expect(r.toolResultContent).toContain("sets");
  });

  it("rejects unknown tools", async () => {
    const r = await executeTool("nope", {}, fakeBackend());
    expect(r.isError).toBe(true);
  });

  it("returns the staged action and preview", async () => {
    const r = await executeTool(
      "log_sets",
      { exercise: { said: "fp" }, sets: [{ reps: 15 }] },
      fakeBackend(),
    );
    expect(r.isError).toBe(false);
    expect(r.staged?.kind).toBe("clarify_exercise");
    expect(r.toolResultContent).toBe("staged fp");
  });

  it("surfaces backend errors as is_error", async () => {
    const r = await executeTool("undo_last_entry", {}, fakeBackend());
    expect(r).toMatchObject({ isError: true, toolResultContent: "nothing to undo" });
  });
});

describe("read tools", () => {
  it("get_session accepts no input, a day or a date, never both", async () => {
    const b = fakeBackend();
    expect((await executeTool("get_session", {}, b)).isError).toBe(false);
    expect((await executeTool("get_session", { day: "yesterday" }, b)).isError).toBe(false);
    expect((await executeTool("get_session", { date: "2026-10-26" }, b)).isError).toBe(false);
    const both = await executeTool("get_session", { day: "mon", date: "2026-10-26" }, b);
    expect(both.isError).toBe(true);
    expect(both.toolResultContent).toContain("either day or date");
    expect((await executeTool("get_session", { date: "26/10" }, b)).isError).toBe(true);
    expect((await executeTool("get_session", { day: "sat" }, b)).isError).toBe(false);
    expect((await executeTool("get_session", { day: "sun" }, b)).isError).toBe(false);
    expect((await executeTool("get_session", { day: "xyz" }, b)).isError).toBe(true);
  });

  it("returns the facts as JSON and the fallback separately", async () => {
    const r = await executeTool("get_session", {}, fakeBackend());
    expect(r.toolResultContent).toBe(JSON.stringify({ items: [] }));
    expect(r.read).toEqual({ fallbackHtml: "<b>Plan</b>" });
  });

  it("get_exercise_history validates last_n, period and plan_week", async () => {
    const b = fakeBackend();
    const ok = (input: unknown) => executeTool("get_exercise_history", input, b);
    expect((await ok({ exercise: { said: "squat" } })).isError).toBe(false);
    expect(
      (await ok({ exercise: { said: "squat" }, last_n: 10, period: "last_week" })).isError,
    ).toBe(false);
    expect((await ok({ exercise: { said: "squat" }, plan_week: 12 })).isError).toBe(false);
    expect((await ok({ exercise: { said: "squat" }, last_n: 11 })).isError).toBe(true);
    expect((await ok({ exercise: { said: "squat" }, last_n: 0 })).isError).toBe(true);
    expect((await ok({ exercise: { said: "squat" }, plan_week: 13 })).isError).toBe(true);
    expect((await ok({ exercise: { said: "squat" }, period: "next_week" })).isError).toBe(true);
    expect(
      (await ok({ exercise: { said: "squat" }, period: "this_week", plan_week: 2 })).isError,
    ).toBe(true);
    expect((await ok({})).isError).toBe(true);
    expect(b.calls).toEqual(["history:squat", "history:squat", "history:squat"]);
  });

  it("get_alternatives caps want at 100 characters", async () => {
    const b = fakeBackend();
    const run = (want: string) =>
      executeTool("get_alternatives", { exercise: { said: "fp" }, want }, b);
    expect((await run("machine version")).isError).toBe(false);
    expect((await run("x".repeat(101))).isError).toBe(true);
  });
});

describe("save_memory", () => {
  it("stages a limitation or preference and rejects other kinds and long text", async () => {
    const b = fakeBackend();
    const r = await executeTool(
      "save_memory",
      { kind: "limitation", content: "left shoulder sensitive on dips" },
      b,
    );
    expect(r.isError).toBe(false);
    expect(r.staged).toEqual({
      kind: "save_memory",
      input: { kind: "limitation", content: "left shoulder sensitive on dips" },
    });
    expect((await executeTool("save_memory", { kind: "alias", content: "x" }, b)).isError).toBe(
      true,
    );
    expect(
      (await executeTool("save_memory", { kind: "preference", content: "x".repeat(201) }, b))
        .isError,
    ).toBe(true);
    expect(
      (await executeTool("save_memory", { kind: "preference", content: "  " }, b)).isError,
    ).toBe(true);
  });
});

describe("prompt rules", () => {
  const rules = buildSystem(promptStatic, promptContext)[0]?.text ?? "";
  it("covers the M4 behaviour", () => {
    expect(rules).toContain("only when the user names a day");
    expect(rules).toContain("get_exercise_history");
    expect(rules).toContain("Never convert units");
    expect(rules).toContain("not available yet");
    expect(rules).toContain("get_alternatives");
    expect(rules).toContain("NO sets, reps, loads");
    expect(rules).toContain("save_memory only when the user states a lasting");
    expect(rules).toContain("slept badly");
  });

  it("injects limitations and preferences into the dynamic block only", () => {
    const [stat, dyn] = buildSystem(promptStatic, {
      ...promptContext,
      memory: [
        { kind: "limitation", content: "right knee clicks on lunges" },
        { kind: "preference", content: "rings over bar for rows" },
      ],
    });
    expect(dyn?.text).toContain("- limitation: right knee clicks on lunges");
    expect(dyn?.text).toContain("- preference: rings over bar for rows");
    expect(stat?.text).not.toContain("right knee");
  });
});

describe("buildSystem", () => {
  it("caches the static block and keeps it byte-identical across contexts", () => {
    const a = buildSystem(promptStatic, promptContext);
    const b = buildSystem(promptStatic, {
      ...promptContext,
      todayLabel: "Wed",
      pending: { summary: "Squat 3x8", awaitingEdit: true },
      recent: [{ role: "user", text: "hello" }],
    });
    expect(a[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]?.text).not.toBe(b[1]?.text);
    expect(b[1]?.text).toContain("restate the full corrected set");
    expect(a[0]?.text).toContain("squat · Squat");
    expect(a[0]?.text).toContain(
      "When an unsaved request is pending, corrections restate it with log_sets; edit_last_entry and undo_last_entry act only on saved logs.",
    );
  });
});

describe("skip_items input", () => {
  const run = (input: unknown) => executeTool("skip_items", input, fakeBackend());

  it("stages an exercise or the whole session", async () => {
    const one = await run({ exercise: { said: "bulgarian" }, day: "mon" });
    expect(one.isError).toBe(true); // the fake backend has nothing to skip, but the input passed
    expect(one.toolResultContent).toBe("nothing to skip");
    expect((await run({ whole_session: true })).toolResultContent).toBe("nothing to skip");
  });

  it("needs exactly one of exercise or whole_session", async () => {
    for (const bad of [
      {},
      { whole_session: false },
      { exercise: { said: "x" }, whole_session: true },
      { whole_session: true, day: "sat" },
      { exercise: { said: "x" }, extra: 1 },
    ]) {
      const r = await run(bad);
      expect(r.toolResultContent, JSON.stringify(bad)).toContain("Invalid input for skip_items");
    }
  });
});
