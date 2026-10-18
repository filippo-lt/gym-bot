import { DateTime } from "luxon";

export type DayRefResult = { ok: true; date: string } | { ok: false; error: string };

const WEEKDAY_NAMES = [
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "weds", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
  ["sun", "sunday"],
];

const SHORT_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayName = (typeof SHORT_NAMES)[number];

export const DAY_ARG_HINT =
  "Try today, tomorrow, yesterday, a weekday (mon..sun), 2026-10-26 or 26/10.";

function iso(date: string): DateTime {
  return DateTime.fromISO(date, { zone: "utc" });
}

/** "mon".."sun" for any ISO date, weekends included. */
export function dayName(date: string): DayName {
  return SHORT_NAMES[iso(date).weekday - 1] as DayName;
}

function fromParts(y: number, m: number, d: number): string | null {
  const dt = DateTime.utc(y, m, d);
  return dt.isValid ? (dt.toISODate() as string) : null;
}

/**
 * Turns a user's day argument into an ISO date. `today` is the training date (YYYY-MM-DD).
 * A weekday is that day of the current Mon-Sun ISO week, so on a Sunday "mon" is six days ago.
 */
export function parseDayArg(arg: string, today: string): DayRefResult {
  const text = arg.trim().toLowerCase();
  const base = iso(today);
  if (!text) return { ok: false, error: `Which day? ${DAY_ARG_HINT}` };

  if (text === "today") return { ok: true, date: today };
  if (text === "tomorrow") return { ok: true, date: base.plus({ days: 1 }).toISODate() as string };
  if (text === "yesterday") {
    return { ok: true, date: base.minus({ days: 1 }).toISODate() as string };
  }

  const dayIndex = WEEKDAY_NAMES.findIndex((names) => names.includes(text));
  if (dayIndex >= 0) {
    const monday = base.minus({ days: base.weekday - 1 });
    return { ok: true, date: monday.plus({ days: dayIndex }).toISODate() as string };
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoMatch) {
    const date = fromParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return date ? { ok: true, date } : { ok: false, error: `${arg.trim()} is not a real date.` };
  }

  const dm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    if (dm[3] !== undefined) {
      const date = fromParts(Number(dm[3]), m, d);
      return date ? { ok: true, date } : { ok: false, error: `${arg.trim()} is not a real date.` };
    }
    // No year: the year that puts the date closest to today.
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const y of [base.year - 1, base.year, base.year + 1]) {
      const date = fromParts(y, m, d);
      if (!date) continue;
      const distance = Math.abs(iso(date).diff(base, "days").days);
      if (distance < bestDistance) {
        best = date;
        bestDistance = distance;
      }
    }
    return best
      ? { ok: true, date: best }
      : { ok: false, error: `${arg.trim()} is not a real date.` };
  }

  return { ok: false, error: `I don't understand "${arg.trim()}". ${DAY_ARG_HINT}` };
}
