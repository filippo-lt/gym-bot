import { describe, expect, it } from "vitest";
import { hardEndMs, inputKind, MIN_TIME_LEFT_MS } from "../../src/runtime/row-budget.js";

describe("inputKind", () => {
  it.each([
    [{ message: { voice: { file_id: "a" } } }, "voice"],
    [{ message: { photo: [{ file_id: "a" }] } }, "photo"],
    [{ message: { text: "bench 80x5" } }, "text"],
    [{ message: { text: "/today" } }, "other"],
    [{ callback_query: { data: "pa:1:ok" } }, "other"],
    [null, "other"],
  ])("%j is %s", (payload, kind) => {
    expect(inputKind(payload)).toBe(kind);
  });
});

describe("budget", () => {
  it("has the per-kind minimums and a hard end 5 s before maxDuration", () => {
    expect(MIN_TIME_LEFT_MS).toEqual({ voice: 75_000, photo: 60_000, text: 45_000, other: 45_000 });
    expect(hardEndMs(1_000)).toBe(1_000 + 85_000);
  });
});
