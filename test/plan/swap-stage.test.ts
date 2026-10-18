import { describe, expect, it } from "vitest";
import { applySwapAnswer, slugFromName, swapQuestion } from "../../src/plan/swap-stage.js";
import { resolvedSwap } from "./helpers.js";

describe("swapQuestion", () => {
  it("asks the scope first", () => {
    expect(swapQuestion(resolvedSwap())).toBe("scope");
  });
  it("asks the days for rest of plan on several weekdays", () => {
    expect(swapQuestion(resolvedSwap({ scope: "rest" }))).toBe("days");
  });
  it("does not ask when the days are known, one weekday only, or scope is today", () => {
    expect(swapQuestion(resolvedSwap({ scope: "rest", days: "every_day" }))).toBeNull();
    expect(swapQuestion(resolvedSwap({ scope: "rest", futureWeekdays: ["mon"] }))).toBeNull();
    expect(swapQuestion(resolvedSwap({ scope: "today" }))).toBeNull();
  });
});

describe("applySwapAnswer", () => {
  it("t / r set the scope, d / a set the days and recount the sessions", () => {
    const r = resolvedSwap();
    expect(applySwapAnswer(r, "t").scope).toBe("today");
    expect(applySwapAnswer(r, "r").scope).toBe("rest");
    const d = applySwapAnswer(applySwapAnswer(r, "r"), "d");
    expect(d.days).toBe("this_day");
    expect(d.affectedSessions).toBe(8);
    const a = applySwapAnswer(applySwapAnswer(r, "r"), "a");
    expect(a.days).toBe("every_day");
    expect(a.affectedSessions).toBe(14);
  });
});

describe("slugFromName", () => {
  it("lowercases and joins with underscores", () => {
    expect(slugFromName("Band pull-apart")).toBe("band_pull_apart");
    expect(slugFromName("  Cable  Y-raise!! ")).toBe("cable_y_raise");
    expect(slugFromName("???")).toBe("");
  });
});
