/**
 * The one reader of the plan for a date (M7). Versions and one-off overrides are applied here,
 * so callers never pick a version or a swap themselves. Reads are sequential on purpose
 * (session pooler pipelining hazard); nothing here writes or touches logs.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  exercises,
  plannedItemOptions,
  plannedItems,
  plans,
  planVersions,
  planWeeks,
  sessionOverrides,
} from "../db/schema/plan.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
import type { Q } from "../logging/db.js";
import { addDays } from "../plan-import/build-plan.js";
import { computeRir } from "../plan-import/rir.js";
import type {
  FallbackPrescription,
  HiitSpec,
  Modifier,
  Priority,
  Tag,
  Weekday,
} from "../plan-import/types.js";

export interface VersionInfo {
  planId: number;
  versionId: number;
  version: number;
  startDate: string;
  /** Count of the version's plan_weeks rows. */
  weeks: number;
  effectiveFrom: string;
}

export interface WeekInfo {
  versionId: number;
  week: number;
  phase: string;
  isDeload: boolean;
  isTest: boolean;
  startDate: string;
}

export interface PlanDayOption {
  id: number;
  slug: string;
  name: string;
  type: (typeof exercises.$inferSelect)["type"];
  loadBasis: (typeof exercises.$inferSelect)["loadBasis"];
  equipmentId: number | null;
  isMainLift: boolean;
}

export interface PlanDayItem {
  plannedItemId: number;
  itemKey: string;
  itemOrder: number;
  subItem: number;
  block: string;
  planName: string;
  variantLabel: string | null;
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
  hspuStepId: number | null;
  rirMin: number | null;
  rirMax: number | null;
  tags: Tag[];
  priority: Priority;
  note: string | null;
  timeMinMin: number | null;
  timeMinMax: number | null;
  fallback: FallbackPrescription | null;
  /** Overrides applied. */
  options: PlanDayOption[];
  /** Set when a one-off override applies on this date. */
  swappedToday: { from: { id: number; name: string }; to: { id: number; name: string } } | null;
}

export type PlanDay =
  | { kind: "no_plan" }
  | { kind: "before_start"; startDate: string }
  | { kind: "finished"; lastDate: string }
  | {
      kind: "rest";
      date: string;
      versionId: number;
      week: number;
      phase: string;
      isDeload: boolean;
      isTest: boolean;
      weeksTotal: number;
    }
  | {
      kind: "day";
      date: string;
      weekday: Weekday;
      versionId: number;
      week: number;
      phase: string;
      isDeload: boolean;
      isTest: boolean;
      weeksTotal: number;
      items: PlanDayItem[];
    };

export interface VersionIndex {
  versions: VersionInfo[];
  /** Highest version with effective_from <= date, else the lowest. Null without a plan. */
  versionFor(date: string): VersionInfo | null;
  /** The plan week containing `date` under the version that renders it; null outside the plan. */
  weekOf(date: string): WeekInfo | null;
  /** Friday of plan week `week`, using the version effective as of `asOf`. */
  fridayOf(week: number, asOf: string): string;
}

export async function loadVersionIndex(q: Q): Promise<VersionIndex> {
  const [plan] = await q.select().from(plans).orderBy(desc(plans.id)).limit(1);
  const versionRows = plan
    ? await q
        .select()
        .from(planVersions)
        .where(eq(planVersions.planId, plan.id))
        .orderBy(asc(planVersions.version))
    : [];
  const weekRows =
    versionRows.length > 0
      ? await q
          .select()
          .from(planWeeks)
          .where(
            inArray(
              planWeeks.planVersionId,
              versionRows.map((v) => v.id),
            ),
          )
          .orderBy(asc(planWeeks.week))
      : [];
  const weeksByVersion = new Map<number, WeekInfo[]>();
  for (const w of weekRows) {
    const list = weeksByVersion.get(w.planVersionId) ?? [];
    list.push({
      versionId: w.planVersionId,
      week: w.week,
      phase: w.phase,
      isDeload: w.isDeload,
      isTest: w.isTest,
      startDate: w.startDate,
    });
    weeksByVersion.set(w.planVersionId, list);
  }
  const versions: VersionInfo[] = plan
    ? versionRows.map((v) => ({
        planId: plan.id,
        versionId: v.id,
        version: v.version,
        startDate: plan.startDate,
        weeks: weeksByVersion.get(v.id)?.length ?? 0,
        effectiveFrom: v.effectiveFrom,
      }))
    : [];

  const versionFor = (date: string): VersionInfo | null => {
    let pick: VersionInfo | null = null;
    for (const v of versions) if (v.effectiveFrom <= date) pick = v;
    return pick ?? versions[0] ?? null;
  };
  const weekOf = (date: string): WeekInfo | null => {
    const v = versionFor(date);
    if (!v) return null;
    const status = planWeekFor(date, v.startDate, v.weeks);
    if (status.status !== "active") return null;
    return weeksByVersion.get(v.versionId)?.find((w) => w.week === status.week) ?? null;
  };
  const fridayOf = (week: number, asOf: string): string => {
    const v = versionFor(asOf);
    const row = v ? weeksByVersion.get(v.versionId)?.find((w) => w.week === week) : undefined;
    if (row) return addDays(row.startDate, 4);
    const start = v?.startDate ?? versions[0]?.startDate;
    if (!start) throw new Error("No plan found in the database.");
    return addDays(start, (week - 1) * 7 + 4);
  };
  return { versions, versionFor, weekOf, fridayOf };
}

/** The plan version that renders `date` (Rome calendar date, YYYY-MM-DD). */
export async function versionOn(q: Q, date: string): Promise<VersionInfo | null> {
  return (await loadVersionIndex(q)).versionFor(date);
}

function lastDateOf(version: VersionInfo): string {
  return addDays(version.startDate, version.weeks * 7 - 1);
}

type ItemRow = typeof plannedItems.$inferSelect;
type OverrideRow = typeof sessionOverrides.$inferSelect;

/**
 * The pure part of rendering a day: the item rows with their options and the one-off overrides
 * that belong to this date. An override whose replaced exercise is not an option of the item is
 * ignored; with several overrides on one item, swappedToday shows the last one applied.
 */
function composeItems(
  rows: ItemRow[],
  optionsById: Map<number, PlanDayOption[]>,
  overridesById: Map<number, OverrideRow[]>,
  known: Map<number, PlanDayOption>,
  weekIsDeload: boolean,
): PlanDayItem[] {
  return rows.map((r) => {
    let options = optionsById.get(r.id) ?? [];
    let swappedToday: PlanDayItem["swappedToday"] = null;
    for (const ov of overridesById.get(r.id) ?? []) {
      const replacement = known.get(ov.replacementExerciseId);
      const idx = options.findIndex((o) => o.id === ov.replacedExerciseId);
      if (!replacement || idx < 0) continue;
      const replaced = options[idx] as PlanDayOption;
      const mapped = options.map((o, i) => (i === idx ? replacement : o));
      options = mapped.filter((o, i) => mapped.findIndex((p) => p.id === o.id) === i);
      swappedToday = {
        from: { id: replaced.id, name: replaced.name },
        to: { id: replacement.id, name: replacement.name },
      };
    }
    let rirMin = r.rirMin;
    let rirMax = r.rirMax;
    let hspuStepId = r.hspuStepId;
    let fallback = r.fallbackPrescription;
    if (swappedToday) {
      const rir = computeRir({
        options: options.map((o) => ({ type: o.type, is_main_lift: o.isMainLift })),
        modifiers: r.modifiers as Modifier[],
        weekIsDeload,
      });
      rirMin = rir.rir_min;
      rirMax = rir.rir_max;
      hspuStepId = null;
      fallback = null;
    }
    return {
      plannedItemId: r.id,
      itemKey: r.itemKey,
      itemOrder: r.itemOrder,
      subItem: r.subItem,
      block: r.block,
      planName: r.planName,
      variantLabel: r.variantLabel,
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
      hspuStepId,
      rirMin,
      rirMax,
      tags: r.tags as Tag[],
      priority: r.priority as Priority,
      note: r.note,
      timeMinMin: r.timeMinMin,
      timeMinMax: r.timeMinMax,
      fallback,
      options,
      swappedToday,
    };
  });
}

interface DaySlot {
  position: number;
  date: string;
  weekday: Weekday;
  versionId: number;
  week: number;
  isDeload: boolean;
  common: Omit<Extract<PlanDay, { kind: "rest" }>, "kind">;
}

/**
 * Several dates through an already loaded index with a fixed number of queries (planned items,
 * options, overrides, extra replacement exercises), whatever the number of dates.
 */
export async function planDaysFromIndex(
  q: Q,
  index: VersionIndex,
  dates: string[],
): Promise<PlanDay[]> {
  const out: PlanDay[] = new Array(dates.length);
  const slots: DaySlot[] = [];
  for (const [position, date] of dates.entries()) {
    const version = index.versionFor(date);
    if (!version) {
      out[position] = { kind: "no_plan" };
      continue;
    }
    const status = planWeekFor(date, version.startDate, version.weeks);
    if (status.status === "before_start") {
      out[position] = { kind: "before_start", startDate: version.startDate };
      continue;
    }
    if (status.status === "finished") {
      out[position] = { kind: "finished", lastDate: lastDateOf(version) };
      continue;
    }
    const week = index.weekOf(date);
    if (!week) throw new Error(`Plan week ${status.week} is missing.`);
    const common = {
      date,
      versionId: version.versionId,
      week: week.week,
      phase: week.phase,
      isDeload: week.isDeload,
      isTest: week.isTest,
      weeksTotal: version.weeks,
    };
    const weekday = weekdayOf(date);
    if (!weekday) {
      out[position] = { kind: "rest", ...common };
      continue;
    }
    slots.push({
      position,
      date,
      weekday,
      versionId: version.versionId,
      week: week.week,
      isDeload: week.isDeload,
      common,
    });
  }
  if (slots.length === 0) return out;

  const rows = await q
    .select()
    .from(plannedItems)
    .where(
      and(
        inArray(plannedItems.planVersionId, [...new Set(slots.map((s) => s.versionId))]),
        inArray(plannedItems.week, [...new Set(slots.map((s) => s.week))]),
        inArray(plannedItems.weekday, [...new Set(slots.map((s) => s.weekday))]),
      ),
    )
    .orderBy(asc(plannedItems.itemOrder), asc(plannedItems.subItem));
  const rowsOf = (s: DaySlot) =>
    rows.filter(
      (r) => r.planVersionId === s.versionId && r.week === s.week && r.weekday === s.weekday,
    );
  const ids = slots.flatMap((s) => rowsOf(s).map((r) => r.id));

  const optionRows = ids.length
    ? await q
        .select({
          plannedItemId: plannedItemOptions.plannedItemId,
          id: exercises.id,
          slug: exercises.slug,
          name: exercises.name,
          type: exercises.type,
          loadBasis: exercises.loadBasis,
          equipmentId: exercises.equipmentId,
          isMainLift: exercises.isMainLift,
          muscleGroup: exercises.muscleGroup,
        })
        .from(plannedItemOptions)
        .innerJoin(exercises, eq(exercises.id, plannedItemOptions.exerciseId))
        .where(inArray(plannedItemOptions.plannedItemId, ids))
        .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex))
    : [];
  const overrideRows = ids.length
    ? await q
        .select()
        .from(sessionOverrides)
        .where(
          and(
            inArray(
              sessionOverrides.sessionDate,
              slots.map((s) => s.date),
            ),
            inArray(sessionOverrides.plannedItemId, ids),
          ),
        )
        .orderBy(asc(sessionOverrides.id))
    : [];

  const optionsById = new Map<number, PlanDayOption[]>();
  const known = new Map<number, PlanDayOption>();
  for (const o of optionRows) {
    const { plannedItemId, muscleGroup: _m, ...opt } = o;
    const list = optionsById.get(plannedItemId) ?? [];
    list.push(opt);
    optionsById.set(plannedItemId, list);
    known.set(opt.id, opt);
  }
  const missing = [
    ...new Set(overrideRows.map((o) => o.replacementExerciseId).filter((id) => !known.has(id))),
  ];
  if (missing.length > 0) {
    const extra = await q
      .select({
        id: exercises.id,
        slug: exercises.slug,
        name: exercises.name,
        type: exercises.type,
        loadBasis: exercises.loadBasis,
        equipmentId: exercises.equipmentId,
        isMainLift: exercises.isMainLift,
      })
      .from(exercises)
      .where(inArray(exercises.id, missing));
    for (const e of extra) known.set(e.id, e);
  }

  for (const s of slots) {
    const overridesById = new Map<number, OverrideRow[]>();
    for (const o of overrideRows) {
      if (o.sessionDate !== s.date) continue;
      const list = overridesById.get(o.plannedItemId) ?? [];
      list.push(o);
      overridesById.set(o.plannedItemId, list);
    }
    out[s.position] = {
      kind: "day",
      weekday: s.weekday,
      ...s.common,
      items: composeItems(rowsOf(s), optionsById, overridesById, known, s.isDeload),
    };
  }
  return out;
}

/** One date through an already loaded index (use planDaysFromIndex for several dates). */
export async function planDayFromIndex(q: Q, index: VersionIndex, date: string): Promise<PlanDay> {
  return (await planDaysFromIndex(q, index, [date]))[0] as PlanDay;
}

/** Everything needed to render or reason about one date. */
export async function planDayOn(q: Q, date: string): Promise<PlanDay> {
  return planDayFromIndex(q, await loadVersionIndex(q), date);
}

/** Inclusive range of dates: one version index load, then one batched read of the items. */
export async function planDaysBetween(q: Q, from: string, to: string): Promise<PlanDay[]> {
  const index = await loadVersionIndex(q);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return planDaysFromIndex(q, index, dates);
}
