import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { classLogs, sessionItems } from "../db/schema/log.js";
import {
  exercises,
  hspuLadder,
  plannedItemOptions,
  plannedItems,
  plans,
  planVersions,
  planWeeks,
} from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
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

interface PlanContext {
  plan: { id: number; startDate: string; weeks: number };
  versionId: number;
}

async function loadPlanContext(db: Db, date: string): Promise<PlanContext> {
  const [plan] = await db.select().from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) throw new Error("No plan found in the database.");
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
  if (!version) throw new Error("The plan has no versions.");
  return {
    plan: { id: plan.id, startDate: plan.startDate, weeks: plan.weeks },
    versionId: version.id,
  };
}

async function loadWeekRow(db: Db, versionId: number, week: number) {
  const [row] = await db
    .select()
    .from(planWeeks)
    .where(and(eq(planWeeks.planVersionId, versionId), eq(planWeeks.week, week)));
  if (!row) throw new Error(`Plan week ${week} is missing.`);
  return row;
}

export async function getSession(db: Db, date: string): Promise<Session> {
  const ctx = await loadPlanContext(db, date);
  const status = planWeekFor(date, ctx.plan.startDate, ctx.plan.weeks);
  if (status.status === "before_start") {
    return { kind: "before_start", startDate: ctx.plan.startDate };
  }
  if (status.status === "finished") return { kind: "finished" };

  const weekRow = await loadWeekRow(db, ctx.versionId, status.week);
  const weekday = weekdayOf(date);
  if (!weekday) {
    return { kind: "rest", date, week: status.week, phase: weekRow.phase };
  }

  const rows = await db
    .select()
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.planVersionId, ctx.versionId),
        eq(plannedItems.week, status.week),
        eq(plannedItems.weekday, weekday),
      ),
    )
    .orderBy(asc(plannedItems.itemOrder), asc(plannedItems.subItem));

  const ids = rows.map((r) => r.id);
  const stepRows = await db.select({ id: hspuLadder.id, name: hspuLadder.name }).from(hspuLadder);
  const stepNames = new Map(stepRows.map((r) => [r.id, r.name]));
  const optionRows = ids.length
    ? await db
        .select({
          plannedItemId: plannedItemOptions.plannedItemId,
          optionIndex: plannedItemOptions.optionIndex,
          slug: exercises.slug,
          name: exercises.name,
        })
        .from(plannedItemOptions)
        .innerJoin(exercises, eq(exercises.id, plannedItemOptions.exerciseId))
        .where(inArray(plannedItemOptions.plannedItemId, ids))
        .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex))
    : [];
  const statusRows = ids.length
    ? await db
        .select({ plannedItemId: sessionItems.plannedItemId, status: sessionItems.status })
        .from(sessionItems)
        .where(and(eq(sessionItems.sessionDate, date), inArray(sessionItems.plannedItemId, ids)))
    : [];

  const optionsById = new Map<number, { slug: string; name: string }[]>();
  for (const o of optionRows) {
    const list = optionsById.get(o.plannedItemId) ?? [];
    list.push({ slug: o.slug, name: o.name });
    optionsById.set(o.plannedItemId, list);
  }
  const statusById = new Map(statusRows.map((s) => [s.plannedItemId, s.status]));

  const items: SessionItem[] = rows.map((r) => ({
    plannedItemId: r.id,
    itemOrder: r.itemOrder,
    subItem: r.subItem,
    block: r.block,
    planName: r.planName,
    variantLabel: r.variantLabel,
    options: optionsById.get(r.id) ?? [],
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
    modifiers: r.modifiers as Modifier[],
    hspuStep: r.hspuStepId == null ? null : (stepNames.get(r.hspuStepId) ?? null),
    rirMin: r.rirMin,
    rirMax: r.rirMax,
    tags: r.tags as Tag[],
    priority: r.priority as Priority,
    note: r.note,
    timeMinMin: r.timeMinMin,
    timeMinMax: r.timeMinMax,
    fallback: r.fallbackPrescription,
    status: statusById.get(r.id) ?? "planned",
  }));

  const result: Session = {
    kind: "session",
    date,
    week: status.week,
    phase: weekRow.phase,
    isDeload: weekRow.isDeload,
    isTest: weekRow.isTest,
    weekday,
    focus: DAY_FOCUS[weekday],
    items,
  };

  if (weekday === "fri") {
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
  const ctx = await loadPlanContext(db, date);
  const status = planWeekFor(date, ctx.plan.startDate, ctx.plan.weeks);
  if (status.status === "before_start") {
    return { kind: "before_start", startDate: ctx.plan.startDate };
  }
  if (status.status === "finished") return { kind: "finished" };

  const weekRow = await loadWeekRow(db, ctx.versionId, status.week);
  const mains = await db
    .select({ id: plannedItems.id, weekday: plannedItems.weekday })
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.planVersionId, ctx.versionId),
        eq(plannedItems.week, status.week),
        eq(plannedItems.subItem, 0),
      ),
    );
  const exposureRows = mains.length
    ? await db
        .select({ id: plannedItemOptions.plannedItemId })
        .from(plannedItemOptions)
        .innerJoin(exercises, eq(exercises.id, plannedItemOptions.exerciseId))
        .where(
          and(
            eq(exercises.slug, "class_exposure"),
            inArray(
              plannedItemOptions.plannedItemId,
              mains.map((m) => m.id),
            ),
          ),
        )
    : [];
  const exposure = new Set(exposureRows.map((r) => r.id));
  const real = mains.filter((m) => !exposure.has(m.id));
  const ids = real.map((m) => m.id);
  const dates = WEEKDAY_ORDER.map((_, i) =>
    DateTime.fromISO(weekRow.startDate, { zone: "utc" }).plus({ days: i }).toISODate(),
  ) as string[];
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
    const dayIds = new Set(real.filter((m) => m.weekday === weekday).map((m) => m.id));
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
    week: status.week,
    phase: weekRow.phase,
    isDeload: weekRow.isDeload,
    isTest: weekRow.isTest,
    startDate: weekRow.startDate,
    days,
  };
}
