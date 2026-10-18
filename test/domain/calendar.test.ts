import { describe, expect, it } from "vitest";
import {
  planWeekFor,
  romeLocalToUtc,
  thursdayOnOrBefore,
  trainingDate,
  weekdayOf,
} from "../../src/domain/calendar.js";

const START = "2026-09-28";

describe("planWeekFor", () => {
  it("week 1 spans 2026-09-28..2026-10-04", () => {
    expect(planWeekFor("2026-09-28", START, 12)).toEqual({ status: "active", week: 1 });
    expect(planWeekFor("2026-10-04", START, 12)).toEqual({ status: "active", week: 1 });
    expect(planWeekFor("2026-10-05", START, 12)).toEqual({ status: "active", week: 2 });
  });
  it("2026-10-19 is week 4", () => {
    expect(planWeekFor("2026-10-19", START, 12)).toEqual({ status: "active", week: 4 });
  });
  it("last day of week 12 is active, the next day is finished", () => {
    expect(planWeekFor("2026-12-20", START, 12)).toEqual({ status: "active", week: 12 });
    expect(planWeekFor("2026-12-21", START, 12)).toEqual({ status: "finished" });
  });
  it("before the start date", () => {
    expect(planWeekFor("2026-09-27", START, 12)).toEqual({ status: "before_start" });
  });
});

describe("weekdayOf", () => {
  it("maps Mon..Fri and returns null on the weekend", () => {
    expect(weekdayOf("2026-09-28")).toBe("mon");
    expect(weekdayOf("2026-10-02")).toBe("fri");
    expect(weekdayOf("2026-10-03")).toBeNull();
    expect(weekdayOf("2026-10-04")).toBeNull();
  });
});

describe("trainingDate", () => {
  it("Tue 02:59 Rome belongs to Monday", () => {
    expect(trainingDate(romeLocalToUtc("2026-09-29", "02:59"))).toBe("2026-09-28");
  });
  it("Tue 03:00 Rome is Tuesday", () => {
    expect(trainingDate(romeLocalToUtc("2026-09-29", "03:00"))).toBe("2026-09-29");
  });
});

describe("romeLocalToUtc", () => {
  it("06:00 on 2026-10-26 (after DST ends) is 05:00Z", () => {
    expect(romeLocalToUtc("2026-10-26", "06:00").toISOString()).toBe("2026-10-26T05:00:00.000Z");
  });
  it("06:00 on 2026-10-23 (summer time) is 04:00Z", () => {
    expect(romeLocalToUtc("2026-10-23", "06:00").toISOString()).toBe("2026-10-23T04:00:00.000Z");
  });
});

describe("thursdayOnOrBefore", () => {
  it.each([
    ["2026-10-01", "2026-10-01"], // Thursday itself
    ["2026-10-02", "2026-10-01"], // Friday
    ["2026-10-04", "2026-10-01"], // Sunday
    ["2026-10-05", "2026-10-01"], // Monday
    ["2026-10-07", "2026-10-01"], // Wednesday
    ["2026-10-08", "2026-10-08"],
  ])("%s -> %s", (date, expected) => {
    expect(thursdayOnOrBefore(date)).toBe(expected);
  });
});
