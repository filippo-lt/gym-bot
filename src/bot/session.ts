import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { classLogs, sessionItems } from "../db/schema/log.js";
import { hspuLadder } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { planDayOn, planDaysBetween } from "../plan/effective.js";
import type {
  FallbackPrescription,
  HiitSpec,
  Modifier,
  Priority,
  Tag,
  Weekday,
} from "../plan-import/types.js";

export type ItemStatus = "planned" | "done" | "modified" | "skipped";
export type HeavyGroup = "pull" | "push" | "legs";

/** Day focus lines. Kept equal to `day_focus` in seed/hybrid-strength-plan.json (see unit test). */
export const DAY_FOCUS: Record<Weekday, string> = {
  mon: "Pull + hinge",
  tue: "HSPU + push + squat",
  wed: "HIIT + mobility",
  thu: "Calisthenics class",
  fri: "Full-body strength",
};

export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export interface SessionItem {
  plannedItemId: number;
  itemOrder: number;
  subItem: number;
  block: string;
  planName: string;
  variantLabel: string | null;
  options: { slug: string; name: string }[];
  prescriptionRaw: string;
  extrasRaw: string | null;
  setsMin: number | null;
  setsMax: number | null;
  repsMin: number | null;
  repsMax: number | null;
  perSide: boolean;
  durationSMin: number | null;
  durationSMax: number | null;
  hiit: HiitSpec | null;
  tempo: string | null;
  modifiers: Modifier[];
  /** Ladder step name for HSPU items, when the plan names one. */
  hspuStep?: string | null;
  rirMin: number | null;
  rirMax: number | null;
  tags: Tag[];
  priority: Priority;
  note: string | null;
  timeMinMin: number | null;
  timeMinMax: number | null;
  fallback: FallbackPrescription | null;
  status: ItemStatus;
  /** Name of the exercise a one-off swap replaced today, for "instead of X today". */
  swappedFrom: string | null;
}

export type Session =
  | { kind: "before_start"; startDate: string }
  | { kind: "finished" }
  | { kind: "rest"; date: string; week: number; phase: string }
  | {
      kind: "session";
      date: string;
      week: number;
      phase: string;
      isDeload: boolean;
      isTest: boolean;
      weekday: Weekday;
      focus: string;
      items: SessionItem[];
      /** Only set on Fridays. */
      thursday?: { heavy: HeavyGroup[] } | "not_reported";
    };

export interface WeekDay {
  date: string;
  weekday: Weekday;
  focus: string;
  total: number;
  done: number;
  skipped: number;
  modified: number;
}

export type WeekOverview =
  | { kind: "before_start"; startDate: string }
  | { kind: "finished" }
  | {
      kind: "week";
      week: number;
      phase: string;
      isDeload: boolean;
      isTest: boolean;
      startDate: string;
      days: WeekDay[];
    };

export async function getSession(db: Db, date: string): Promise<Session> {
  const day = await planDayOn(db, date);
  if (day.kind === "no_plan") throw new Error("No plan found in the database.");
  if (day.kind === "before_start") return { kind: "before_start", startDate: day.startDate };
  if (day.kind === "finished") return { kind: "finished" };
  if (day.kind === "rest") return { kind: "rest", date, week: day.week, phase: day.phase };

  const ids = day.items.map((r) => r.plannedItemId);
  const stepRows = await db.select({ id: hspuLadder.id, name: hspuLadder.name }).from(hspuLadder);
  const stepNames = new Map(stepRows.map((r) => [r.id, r.name]));
  const statusRows = ids.length
    ? await db
        .select({ plannedItemId: sessionItems.plannedItemId, status: sessionItems.status })
        .from(sessionItems)
        .where(and(eq(sessionItems.sessionDate, date), inArray(sessionItems.plannedItemId, ids)))
    : [];
  const statusById = new Map(statusRows.map((s) => [s.plannedItemId, s.status]));

  const items: SessionItem[] = day.items.map((r) => ({
    plannedItemId: r.plannedItemId,
    itemOrder: r.itemOrder,
    subItem: r.subItem,
    block: r.block,
    planName: r.planName,
    variantLabel: r.variantLabel,
    options: r.options.map((o) => ({ slug: o.slug, name: o.name })),
    prescriptionRaw: r.prescriptionRaw,
    extrasRaw: r.extrasRaw,
    setsMin: r.setsMin,
    setsMax: r.setsMax,
    repsMin: r.repsMin,
    repsMax: r.repsMax,
    perSide: r.perSide,
    durationSMin: r.durationSMin,
    durationSMax: r.durationSMax,
    hiit: r.hiit,
    tempo: r.tempo,
    modifiers: r.modifiers,
    hspuStep: r.hspuStepId == null ? null : (stepNames.get(r.hspuStepId) ?? null),
    rirMin: r.rirMin,
    rirMax: r.rirMax,
    tags: r.tags,
    priority: r.priority,
    note: r.note,
    timeMinMin: r.timeMinMin,
    timeMinMax: r.timeMinMax,
    fallback: r.fallback,
    status: statusById.get(r.plannedItemId) ?? "planned",
    swappedFrom: r.swappedToday?.from.name ?? null,
  }));

  const result: Session = {
    kind: "session",
    date,
    week: day.week,
    phase: day.phase,
    isDeload: day.isDeload,
    isTest: day.isTest,
    weekday: day.weekday,
    focus: DAY_FOCUS[day.weekday],
    items,
  };

  if (day.weekday === "fri") {
    const thursday = DateTime.fromISO(date, { zone: "utc" }).minus({ days: 1 }).toISODate();
    const [log] = await db
      .select({ heavyGroups: classLogs.heavyGroups })
      .from(classLogs)
      .where(eq(classLogs.date, thursday as string));
    result.thursday = log ? { heavy: log.heavyGroups as HeavyGroup[] } : "not_reported";
  }
  return result;
}

export async function getWeek(db: Db, date: string): Promise<WeekOverview> {
  const first = await planDayOn(db, date);
  if (first.kind === "no_plan") throw new Error("No plan found in the database.");
  if (first.kind === "before_start") return { kind: "before_start", startDate: first.startDate };
  if (first.kind === "finished") return { kind: "finished" };

  // Each day of the week is read under the version effective on that day: a week can straddle two.
  const monday = DateTime.fromISO(date, { zone: "utc" })
    .minus({ days: DateTime.fromISO(date, { zone: "utc" }).weekday - 1 })
    .toISODate() as string;
  const dates = WEEKDAY_ORDER.map((_, i) =>
    DateTime.fromISO(monday, { zone: "utc" }).plus({ days: i }).toISODate(),
  ) as string[];
  const planDays = await planDaysBetween(db, monday, dates[4] as string);

  // Class exposure never counts as a session item.
  const mainsByDate = new Map<string, number[]>();
  for (const d of planDays) {
    if (d.kind !== "day") continue;
    mainsByDate.set(
      d.date,
      d.items
        .filter((i) => i.subItem === 0 && !i.options.some((o) => o.slug === "class_exposure"))
        .map((i) => i.plannedItemId),
    );
  }
  const ids = [...mainsByDate.values()].flat();
  const statusRows = ids.length
    ? await db
        .select({
          plannedItemId: sessionItems.plannedItemId,
          sessionDate: sessionItems.sessionDate,
          status: sessionItems.status,
        })
        .from(sessionItems)
        .where(inArray(sessionItems.plannedItemId, ids))
    : [];

  const days: WeekDay[] = WEEKDAY_ORDER.map((weekday, i) => {
    const dayDate = dates[i] as string;
    const dayIds = new Set(mainsByDate.get(dayDate) ?? []);
    const mine = statusRows.filter((s) => dayIds.has(s.plannedItemId) && s.sessionDate === dayDate);
    const count = (st: ItemStatus) => mine.filter((s) => s.status === st).length;
    return {
      date: dayDate,
      weekday,
      focus: DAY_FOCUS[weekday],
      total: dayIds.size,
      done: count("done"),
      skipped: count("skipped"),
      modified: count("modified"),
    };
  });

  return {
    kind: "week",
    week: first.week,
    phase: first.phase,
    isDeload: first.isDeload,
    isTest: first.isTest,
    startDate: monday,
    days,
  };
}
