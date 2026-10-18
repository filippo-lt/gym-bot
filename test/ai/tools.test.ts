import { describe, expect, it } from "vitest";
import { buildSystem } from "../../src/ai/prompt.js";
import { executeTool, TOOLS } from "../../src/ai/tools.js";
import { fakeBackend, promptContext, promptStatic } from "./helpers.js";

describe("tool schemas", () => {
  it("has four tools, each a top-level object schema without $schema", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "get_session",
      "log_sets",
      "edit_last_entry",
      "undo_last_entry",
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
