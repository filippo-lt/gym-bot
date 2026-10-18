import { addDays } from "../plan-import/build-plan.js";
import type { ItemSpec, PlanContent, WeekSpec } from "./types.js";

const MIN_GAP_DAYS = 21;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Insert a deload week at `insertAt`, shifting later weeks by one. The next deload week
 * is dropped when it would fall less than 21 days after the inserted one (never the test week).
 */
export function insertDeload(
  content: PlanContent,
  insertAt: number,
): { content: PlanContent; droppedWeek: number | null } {
  const weeks = [...content.weeks].sort((a, b) => a.week - b.week);
  if (weeks.length === 0) throw new Error("Empty plan");
  if (!Number.isInteger(insertAt) || insertAt <= 1 || insertAt > weeks.length) {
    throw new Error(`Cannot insert a deload at week ${insertAt}: must be 2..${weeks.length}`);
  }
  if (weeks.find((w) => w.week === insertAt)?.isDeload) {
    throw new Error(`Week ${insertAt} is already a deload week`);
  }
  const deloadWeeks = weeks.filter((w) => w.isDeload);
  const template =
    deloadWeeks.find((w) => w.week >= insertAt) ??
    deloadWeeks.filter((w) => w.week < insertAt).at(-1);
  if (!template) throw new Error("Plan has no deload week to copy");

  const planStart = (weeks[0] as WeekSpec).startDate;
  const insertedStart = addDays(planStart, 7 * (insertAt - 1));

  // Old week numbers in new order; null marks the inserted week.
  const order: (number | null)[] = [];
  for (const w of weeks) {
    if (w.week === insertAt) order.push(null);
    order.push(w.week);
  }
  if (insertAt > (weeks[weeks.length - 1] as WeekSpec).week) order.push(null);

  const byOld = new Map(weeks.map((w) => [w.week, w]));
  // First deload at or after insertAt (old numbering); it moves one week later.
  const next = weeks.find((w) => w.week >= insertAt && w.isDeload);
  const shiftedStart = next ? addDays(planStart, 7 * next.week) : null;
  const dropped =
    next && shiftedStart && !next.isTest && dayDiff(shiftedStart, insertedStart) < MIN_GAP_DAYS
      ? next.week
      : null;

  const kept = order.filter((o) => o === null || o !== dropped);
  const newNumber = new Map<number, number>();
  const newWeeks: WeekSpec[] = kept.map((old, i) => {
    const week = i + 1;
    const startDate = addDays(planStart, 7 * i);
    if (old === null) {
      return { ...template, week, startDate, phase: "Deload", isDeload: true, isTest: false };
    }
    newNumber.set(old, week);
    return { ...(byOld.get(old) as WeekSpec), week, startDate };
  });

  const insertedWeek = kept.indexOf(null) + 1;
  const items: ItemSpec[] = [];
  const usedKeys = new Set(content.items.map((i) => i.itemKey));
  const uniqueKey = (insertedWeek: number, rest: string): string => {
    let key = `d${pad2(insertedWeek)}-${rest}`;
    for (let n = 2; usedKeys.has(key); n++) key = `d${pad2(insertedWeek)}.${n}-${rest}`;
    usedKeys.add(key);
    return key;
  };
  const copies: ItemSpec[] = content.items
    .filter((i) => i.week === template.week)
    .map((i) => ({
      ...i,
      week: insertedWeek,
      itemKey: uniqueKey(insertedWeek, `${i.weekday}-${pad2(i.itemOrder)}-${i.subItem}`),
      modifiers: [...i.modifiers],
      tags: [...i.tags],
      optionExerciseIds: [...i.optionExerciseIds],
    }));
  for (const old of kept) {
    if (old === null) items.push(...copies);
    else {
      const wk = newNumber.get(old) as number;
      for (const i of content.items) if (i.week === old) items.push({ ...i, week: wk });
    }
  }
  return { content: { weeks: newWeeks, items }, droppedWeek: dropped };
}
