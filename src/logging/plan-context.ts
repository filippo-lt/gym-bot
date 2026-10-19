/** Plan lookups for logging: which planned items exist on a date, and which have a group. */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { logGroups, sessionItems } from "../db/schema/log.js";
import { hspuLadder } from "../db/schema/plan.js";
import { planWeekFor } from "../domain/calendar.js";
import { loadVersionIndex, planDayOn, type VersionIndex } from "../plan/effective.js";
import type { Weekday } from "../plan-import/types.js";
import type { Q } from "./db.js";
import type { Candidate, PlannedItemInfo } from "./types.js";

export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

export interface PlanContext {
  startDate: string;
  /** Week count of the version effective on the date the context was loaded for. */
  weeks: number;
  versionId: number;
  /** Every date is resolved through this index, each with its own version. */
  index: VersionIndex;
}

/** The version effective on `date` (see src/plan/effective.ts), with the index for other dates. */
export async function loadPlanContext(db: Q, date: string): Promise<PlanContext | null> {
  const index = await loadVersionIndex(db);
  const version = index.versionFor(date);
  if (!version) return null;
  return {
    startDate: version.startDate,
    weeks: version.weeks,
    versionId: version.versionId,
    index,
  };
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
  const version = ctx.index.versionFor(date);
  if (!version) return null;
  const s = planWeekFor(date, version.startDate, version.weeks);
  if (s.status !== "active") return null;
  const dayIndex = DateTime.fromISO(date, { zone: "utc" }).weekday - 1;
  return { week: s.week, mondayDate: addDays(date, -dayIndex), dayIndex };
}

export interface DayItem {
  info: PlannedItemInfo;
  options: (Candidate & { id: number })[];
  hasGroup: boolean;
  hspuStepId: number | null;
  variantLabel: string | null;
  /** HSPU ladder step name: the last logged step, else the plan's own; null for other items. */
  hspuStepName: string | null;
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
  const day = await planDayOn(db, date);
  if (day.kind === "rest") return { ...empty, week: day.week };
  if (day.kind !== "day") return empty;
  const ids = day.items.map((r) => r.plannedItemId);
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
  const ladder = new Map(
    (await db.select({ id: hspuLadder.id, name: hspuLadder.name }).from(hspuLadder)).map((l) => [
      l.id,
      l.name,
    ]),
  );
  const hspuNames = new Map<number, string>();
  for (const r of day.items) {
    if (!r.options.some((o) => o.slug === "hspu")) continue;
    const [last] = await db
      .select({ stepId: logGroups.hspuStepId })
      .from(logGroups)
      .where(
        and(
          inArray(
            logGroups.exerciseId,
            r.options.map((o) => o.id),
          ),
          isNotNull(logGroups.hspuStepId),
        ),
      )
      .orderBy(desc(logGroups.sessionDate), desc(logGroups.id))
      .limit(1);
    const name = ladder.get(last?.stepId ?? -1) ?? ladder.get(r.hspuStepId ?? -1);
    if (name) hspuNames.set(r.plannedItemId, name);
  }
  const items: DayItem[] = day.items.map((r) => ({
    info: {
      id: r.plannedItemId,
      subItem: r.subItem,
      week: day.week,
      weekday: day.weekday,
      planName: r.planName,
      priority: r.priority,
      setsMin: r.setsMin,
      setsMax: r.setsMax,
      repsMin: r.repsMin,
      repsMax: r.repsMax,
      rirMin: r.rirMin,
      rirMax: r.rirMax,
      isDeload: day.isDeload,
    },
    options: r.options.map((o) => ({ id: o.id, slug: o.slug, name: o.name })),
    hasGroup: withGroup.has(r.plannedItemId),
    hspuStepId: r.hspuStepId,
    variantLabel: r.variantLabel,
    hspuStepName: hspuNames.get(r.plannedItemId) ?? null,
    status: statusById.get(r.plannedItemId) ?? "planned",
  }));
  return { date, weekday: day.weekday, week: day.week, phase: day.phase, items };
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
