import { describe, expect, it } from "vitest";
import { isFirstWeekdayAfterPlan, morningWindow } from "../../src/jobs/morning.js";

describe("morningWindow", () => {
  it("Mon 06:00 Rome (CET) is due", () => {
    expect(morningWindow(new Date("2026-10-26T05:00:00Z"))).toEqual({ date: "2026-10-26" });
  });
  it("05:45 is not", () => {
    expect(morningWindow(new Date("2026-10-26T04:45:00Z"))).toBeNull();
  });
  it("DST: Fri 06:00 CEST", () => {
    expect(morningWindow(new Date("2026-10-23T04:00:00Z"))).toEqual({ date: "2026-10-23" });
  });
  it("09:45 due, 10:00 not", () => {
    expect(morningWindow(new Date("2026-10-23T07:45:00Z"))).toEqual({ date: "2026-10-23" });
    expect(morningWindow(new Date("2026-10-23T08:00:00Z"))).toBeNull();
  });
  it("not on Sat or Sun", () => {
    expect(morningWindow(new Date("2026-10-24T05:00:00Z"))).toBeNull();
    expect(morningWindow(new Date("2026-10-25T05:00:00Z"))).toBeNull();
  });
});

describe("isFirstWeekdayAfterPlan", () => {
  it("first Monday after the 12 weeks only", () => {
    expect(isFirstWeekdayAfterPlan("2026-12-21", "2026-09-28", 12)).toBe(true);
    expect(isFirstWeekdayAfterPlan("2026-12-22", "2026-09-28", 12)).toBe(false);
    expect(isFirstWeekdayAfterPlan("2026-12-18", "2026-09-28", 12)).toBe(false);
  });
});
