import { describe, expect, it } from "vitest";
import { clampTimeout, runWithDeadline, timeLeftMs } from "../../src/runtime/deadline.js";

describe("deadline", () => {
  it("is unbounded outside a deadline and leaves timeouts unchanged", () => {
    expect(timeLeftMs()).toBe(Number.POSITIVE_INFINITY);
    expect(clampTimeout(40_000)).toBe(40_000);
  });

  it("clamps to the time left minus the margin", async () => {
    await runWithDeadline(Date.now() + 20_000, async () => {
      const ms = clampTimeout(40_000);
      expect(ms).toBeGreaterThan(14_000);
      expect(ms).toBeLessThanOrEqual(15_000);
      expect(clampTimeout(3_000)).toBe(3_000);
    });
  });

  it("never goes below 1 s", async () => {
    await runWithDeadline(Date.now() - 10_000, async () => {
      expect(clampTimeout(40_000)).toBe(1_000);
    });
  });

  it("nested async code sees the deadline", async () => {
    await runWithDeadline(Date.now() + 10_000, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(timeLeftMs()).toBeLessThanOrEqual(10_000);
      expect(Number.isFinite(timeLeftMs())).toBe(true);
    });
    expect(timeLeftMs()).toBe(Number.POSITIVE_INFINITY);
  });
});
