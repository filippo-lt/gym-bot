import { describe, expect, it } from "vitest";
import { dayName, parseDayArg } from "../../src/domain/day-ref.js";

// 2026-10-18 is a Sunday; 2026-10-26 is a Monday.
const SUN = "2026-10-18";
const MON = "2026-10-26";

const ok = (arg: string, today: string) => {
  const r = parseDayArg(arg, today);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.date;
};

describe("parseDayArg", () => {
  it.each([
    ["today", MON, "2026-10-26"],
    ["tomorrow", MON, "2026-10-27"],
    ["yesterday", MON, "2026-10-25"],
    ["Tomorrow", "2026-12-31", "2027-01-01"],
    ["  TODAY ", SUN, SUN],
  ])("%s on %s -> %s", (arg, today, expected) => {
    expect(ok(arg, today)).toBe(expected);
  });

  it("a weekday is that day of the current Mon-Sun week", () => {
    expect(ok("mon", MON)).toBe("2026-10-26");
    expect(ok("fri", MON)).toBe("2026-10-30");
    expect(ok("wed", "2026-10-28")).toBe("2026-10-28");
    expect(ok("mon", "2026-10-30")).toBe("2026-10-26");
  });

  it("on a weekend, mon is the past Monday (the missed session)", () => {
    expect(ok("mon", SUN)).toBe("2026-10-12");
    expect(ok("fri", SUN)).toBe("2026-10-16");
    expect(ok("mon", "2026-10-17")).toBe("2026-10-12"); // Saturday
  });

  it("accepts weekend names and full names, any case", () => {
    expect(ok("sat", MON)).toBe("2026-10-31");
    expect(ok("Sunday", MON)).toBe("2026-11-01");
    expect(ok("MONDAY", MON)).toBe("2026-10-26");
    expect(ok("thursday", MON)).toBe("2026-10-29");
    expect(ok("Tues", MON)).toBe("2026-10-27");
  });

  it("weeks crossing a year boundary", () => {
    // Thu 2026-12-31: Mon is 28 Dec, Sun is 3 Jan 2027.
    expect(ok("mon", "2026-12-31")).toBe("2026-12-28");
    expect(ok("sun", "2026-12-31")).toBe("2027-01-03");
  });

  it("ISO dates", () => {
    expect(ok("2026-10-19", MON)).toBe("2026-10-19");
    expect(parseDayArg("2026-02-30", MON).ok).toBe(false);
  });

  it("DD/MM/YYYY uses the year given", () => {
    expect(ok("19/10/2026", MON)).toBe("2026-10-19");
    expect(ok("5/1/2025", MON)).toBe("2025-01-05");
    expect(parseDayArg("31/02/2026", MON).ok).toBe(false);
  });

  it("DD/MM picks the year closest to today", () => {
    expect(ok("19/10", MON)).toBe("2026-10-19");
    expect(ok("02/01", "2026-12-30")).toBe("2027-01-02");
    expect(ok("28/12", "2027-01-03")).toBe("2026-12-28");
    expect(ok("15/12", "2026-12-30")).toBe("2026-12-15");
    expect(ok("29/02", "2027-12-01")).toBe("2028-02-29");
  });

  it("rejects impossible and unknown input with a message", () => {
    for (const bad of ["31/02", "32/01", "13/13", "someday", "", "  ", "mon tue", "2026/10/19"]) {
      const r = parseDayArg(bad, MON);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe("dayName", () => {
  it("covers the weekend", () => {
    expect(dayName("2026-10-17")).toBe("sat");
    expect(dayName("2026-10-18")).toBe("sun");
    expect(dayName("2026-10-19")).toBe("mon");
  });
});
