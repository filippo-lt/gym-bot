import { describe, expect, it } from "vitest";
import { morningWindow, previousWeekday } from "../../src/jobs/morning.js";

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

describe("previousWeekday", () => {
  it("Monday goes back to Friday, other days to the day before", () => {
    expect(previousWeekday("2026-12-21")).toBe("2026-12-18");
    expect(previousWeekday("2026-12-22")).toBe("2026-12-21");
  });
});
