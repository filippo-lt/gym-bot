import { describe, expect, it } from "vitest";
import { formatUsage } from "../../src/bot/usage-format.js";

describe("formatUsage", () => {
  it("shows used, cap and percent", () => {
    expect(
      formatUsage({
        date: "2026-10-19",
        dayTokens: 12345.6,
        monthTokens: 123456,
        sttSecondsToday: 250,
        caps: { day: 200000, month: 3000000, sttSeconds: 1800 },
      }),
    ).toBe(
      [
        "Usage on 19 Oct:",
        "AI today: 12,346 of 200,000 tokens (6%)",
        "AI this month: 123,456 of 3,000,000 tokens (4%)",
        "Voice today: 4 of 30 min",
      ].join("\n"),
    );
  });

  it("drops the cap part when a cap is missing", () => {
    expect(
      formatUsage({
        date: "2026-10-19",
        dayTokens: 12345,
        monthTokens: 123456,
        sttSecondsToday: 240,
        caps: { day: null, month: null, sttSeconds: null },
      }),
    ).toBe(
      [
        "Usage on 19 Oct:",
        "AI today: 12,345 tokens",
        "AI this month: 123,456 tokens",
        "Voice today: 4 min",
      ].join("\n"),
    );
  });
});
