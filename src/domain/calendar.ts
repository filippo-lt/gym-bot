import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import type { Weekday } from "../plan-import/types.js";

/** Hour (Rome local) before which a timestamp still belongs to the previous training day. */
export const DAY_ROLLOVER_HOUR = 3;

export type PlanWeekStatus =
  | { status: "active"; week: number }
  | { status: "before_start" }
  | { status: "finished" };

const WEEKDAYS: Record<number, Weekday> = { 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri" };

function isoDay(date: string): DateTime {
  const dt = DateTime.fromISO(date, { zone: "utc" });
  if (!dt.isValid) throw new Error(`Invalid ISO date: ${date}`);
  return dt;
}

/** ISO date of "today" in Rome; times before 03:00 belong to the previous day. */
export function trainingDate(now: Date): string {
  const local = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
  const date = local.hour < DAY_ROLLOVER_HOUR ? local.minus({ days: 1 }) : local;
  return date.toISODate() as string;
}

export function planWeekFor(date: string, startDate: string, weeksCount: number): PlanWeekStatus {
  const days = Math.round(isoDay(date).diff(isoDay(startDate), "days").days);
  if (days < 0) return { status: "before_start" };
  const week = Math.floor(days / 7) + 1;
  if (week > weeksCount) return { status: "finished" };
  return { status: "active", week };
}

/** Thursday on or before `date` (today if it is a Thursday): the class day a report belongs to. */
export function thursdayOnOrBefore(date: string): string {
  const dt = isoDay(date);
  const back = (dt.weekday - 4 + 7) % 7;
  return dt.minus({ days: back }).toISODate() as string;
}

export function weekdayOf(date: string): Weekday | null {
  return WEEKDAYS[isoDay(date).weekday] ?? null;
}

export function romeLocalToUtc(date: string, time: string): Date {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: APP_TIMEZONE });
  if (!dt.isValid) throw new Error(`Invalid Rome local time: ${date} ${time}`);
  return dt.toUTC().toJSDate();
}
