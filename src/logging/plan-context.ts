/** Plan lookups for logging: which planned items exist on a date, and which have a group. */
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { logGroups, sessionItems } from "../db/schema/log.js";
import {
  exercises,
  plannedItemOptions,
  plannedItems,
  plans,
  planVersions,
  planWeeks,
} from "../db/schema/plan.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
import type { Priority, Weekday } from "../plan-import/types.js";
import type { Q } from "./db.js";
import type { Candidate, PlannedItemInfo } from "./types.js";

export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export interface PlanContext {
  startDate: string;
  weeks: number;
  versionId: number;
}

/** Same version rule as src/bot/session.ts: latest version effective on `date`, else the first. */
export async function loadPlanContext(db: Q, date: string): Promise<PlanContext | null> {
  const [plan] = await db.select().from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) return null;
  const [effective] = await db
    .select({ id: planVersions.id })
    .from(planVersions)
    .where(and(eq(planVersions.planId, plan.id), lte(planVersions.effectiveFrom, date)))
    .orderBy(desc(planVersions.version))
    .limit(1);
  const version =
    effective ??
    (
      await db
        .select({ id: planVersions.id })
        .from(planVersions)
        .where(eq(planVersions.planId, plan.id))
        .orderBy(asc(planVersions.version))
        .limit(1)
    )[0];
  if (!version) return null;
  return { startDate: plan.startDate, weeks: plan.weeks, versionId: version.id };
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate() as string;
}

export interface WeekRef {
  week: number;
  mondayDate: string;
  /** 0 = Monday ... 6 = Sunday, for the reference date. */
  dayIndex: number;
}

export function weekRefFor(ctx: PlanContext, date: string): WeekRef | null {
  const s = planWeekFor(date, ctx.startDate, ctx.weeks);
  if (s.status !== "active") return null;
  const dayIndex = DateTime.fromISO(date, { zone: "utc" }).weekday - 1;
  return { week: s.week, mondayDate: addDays(date, -dayIndex), dayIndex };
}

export interface DayItem {
  info: PlannedItemInfo;
  options: (Candidate & { id: number })[];
  hasGroup: boolean;
  hspuStepId: number | null;
  status: string;
}

export interface DayPlan {
  date: string;
  weekday: Weekday | null;
  week: number | null;
  phase: string | null;
  items: DayItem[];
}

export async function loadDayPlan(db: Q, ctx: PlanContext | null, date: string): Promise<DayPlan> {
  const empty: DayPlan = { date, weekday: null, week: null, phase: null, items: [] };
  if (!ctx) return empty;
  const ref = weekRefFor(ctx, date);
  const weekday = weekdayOf(date);
  if (!ref || !weekday) return { ...empty, week: ref?.week ?? null };
  const [weekRow] = await db
    .select()
    .from(planWeeks)
    .where(and(eq(planWeeks.planVersionId, ctx.versionId), eq(planWeeks.week, ref.week)));
  const rows = await db
    .select()
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.planVersionId, ctx.versionId),
        eq(plannedItems.week, ref.week),
        eq(plannedItems.weekday, weekday),
      ),
    )
    .orderBy(asc(plannedItems.itemOrder), asc(plannedItems.subItem));
  const ids = rows.map((r) => r.id);
  const optionRows = ids.length
    ? await db
        .select({
          plannedItemId: plannedItemOptions.plannedItemId,
          id: exercises.id,
          slug: exercises.slug,
          name: exercises.name,
        })
        .from(plannedItemOptions)
        .innerJoin(exercises, eq(exercises.id, plannedItemOptions.exerciseId))
        .where(inArray(plannedItemOptions.plannedItemId, ids))
        .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex))
    : [];
  const groupRows = ids.length
    ? await db
        .select({ plannedItemId: logGroups.plannedItemId })
        .from(logGroups)
        .where(and(eq(logGroups.sessionDate, date), inArray(logGroups.plannedItemId, ids)))
    : [];
  const statusRows = ids.length
    ? await db
        .select({ plannedItemId: sessionItems.plannedItemId, status: sessionItems.status })
        .from(sessionItems)
        .where(and(eq(sessionItems.sessionDate, date), inArray(sessionItems.plannedItemId, ids)))
    : [];
  const withGroup = new Set(groupRows.map((g) => g.plannedItemId));
  const statusById = new Map(statusRows.map((s) => [s.plannedItemId, s.status]));
  const items: DayItem[] = rows.map((r) => ({
    info: {
      id: r.id,
      subItem: r.subItem,
      week: r.week,
      weekday: r.weekday,
      planName: r.planName,
      priority: r.priority as Priority,
      setsMin: r.setsMin,
      setsMax: r.setsMax,
      repsMin: r.repsMin,
      repsMax: r.repsMax,
      rirMin: r.rirMin,
      rirMax: r.rirMax,
      isDeload: weekRow?.isDeload ?? false,
    },
    options: optionRows
      .filter((o) => o.plannedItemId === r.id)
      .map((o) => ({ id: o.id, slug: o.slug, name: o.name })),
    hasGroup: withGroup.has(r.id),
    hspuStepId: r.hspuStepId,
    status: statusById.get(r.id) ?? "planned",
  }));
  return { date, weekday, week: ref.week, phase: weekRow?.phase ?? null, items };
}

/** An item already marked done or skipped (e.g. by the history import). */
export const isSettled = (status: string): boolean => status === "done" || status === "skipped";

/** Several matches: first open one (no group, not done/skipped), then one without a group, else the last. */
export function pickItem(items: DayItem[], exerciseId: number): DayItem | null {
  const matches = items.filter((i) => i.options.some((o) => o.id === exerciseId));
  if (matches.length === 0) return null;
  // Falling back to a settled item is intended for the target day: logging today after an
  // earlier skip marks it done, and undo restores it. Make-ups skip settled items elsewhere.
  return (
    matches.find((i) => !i.hasGroup && !isSettled(i.status)) ??
    matches.find((i) => !i.hasGroup) ??
    (matches[matches.length - 1] as DayItem)
  );
}
