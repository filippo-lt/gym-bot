import { describe, expect, it } from "vitest";
import { countedTokens, overTokenBudget } from "../../src/ai/budget.js";
import { fakeUsage } from "./helpers.js";

const NOW = new Date("2026-10-27T10:00:00Z");
const caps = { dailyTokenCap: 1000, monthlyTokenCap: 10000 };

describe("countedTokens", () => {
  it("weights cache writes 1.25 and cache reads 0.1", () => {
    expect(
      countedTokens({
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 20,
        cacheReadTokens: 1000,
      }),
    ).toBe(275);
  });
});

describe("overTokenBudget", () => {
  it.each([
    ["day", { day: 1000, month: 1000 }],
    ["month", { day: 0, month: 10000 }],
    ["day", { day: 1000, month: 10000 }],
    [null, { day: 999, month: 9999 }],
  ])("returns %s", async (cap, totals) => {
    expect(await overTokenBudget(fakeUsage(totals), NOW, caps)).toBe(cap);
  });
});
