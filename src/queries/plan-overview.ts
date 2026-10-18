/** Read-only plan facts for /plan and /next. */
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { Session, SessionItem } from "../bot/session.js";
import { DAY_FOCUS } from "../bot/session.js";
import { exercises, plans, planVersions, planWeeks } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
import { addDays, loadPlanContext } from "../logging/plan-context.js";
import type { Weekday } from "../plan-import/types.js";

export interface PlanPhase {
  fromWeek: number;
  toWeek: number;
  phase: string;
}

/** One saved plan change (version > 1 of the newest plan), names resolved. */
export interface PlanChangeLine {
  effectiveFrom: string;
  change:
    | { kind: "swap"; from: string; to: string; weekdays: Weekday[] | "all" }
    | { kind: "deload_earlier"; insertedWeek: number; droppedWeek: number | null };
}

export interface PlanOverview {
  status: "before_start" | "active" | "finished";
  startDate: string;
  /** Null unless the plan is active. */
  week: number | null;
  phase: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  phases: PlanPhase[];
  nextDeload: { week: number; startDate: string } | null;
  nextTrainingDay: { date: string; weekday: Weekday; focus: string } | null;
  /** Oldest first. */
  changes: PlanChangeLine[];
}

async function loadChanges(db: Db): Promise<PlanChangeLine[]> {
  const [plan] = await db.select({ id: plans.id }).from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) return [];
  const rows = await db
    .select({ effectiveFrom: planVersions.effectiveFrom, change: planVersions.change })
    .from(planVersions)
    .where(and(eq(planVersions.planId, plan.id), gt(planVersions.version, 1)))
    .orderBy(asc(planVersions.version));
  const ids = rows.flatMap((r) => (r.change?.kind === "swap" ? [r.change.from, r.change.to] : []));
  const named = ids.length
    ? await db
        .select({ id: exercises.id, name: exercises.name })
        .from(exercises)
        .where(inArray(exercises.id, ids))
    : [];
  const names = new Map(named.map((e) => [e.id, e.name]));
  const out: PlanChangeLine[] = [];
  for (const r of rows) {
    const c = r.change;
    if (!c) continue;
    if (c.kind === "swap") {
      out.push({
        effectiveFrom: r.effectiveFrom,
        change: {
          kind: "swap",
          from: names.get(c.from) ?? "?",
          to: names.get(c.to) ?? "?",
          weekdays: c.weekdays,
        },
      });
    } else {
      out.push({ effectiveFrom: r.effectiveFrom, change: c });
    }
  }
  return out;
}

/** Consecutive weeks with the same phase name become one range. */
export function groupPhases(weeks: { week: number; phase: string }[]): PlanPhase[] {
  const out: PlanPhase[] = [];
  for (const w of [...weeks].sort((a, b) => a.week - b.week)) {
    const last = out[out.length - 1];
    if (last && last.phase === w.phase && last.toWeek === w.week - 1) last.toWeek = w.week;
    else out.push({ fromWeek: w.week, toWeek: w.week, phase: w.phase });
  }
  return out;
}

export async function getPlanOverview(db: Db, today: string): Promise<PlanOverview | null> {
  const ctx = await loadPlanContext(db, today);
  if (!ctx) return null;
  const weekRows = await db
    .select()
    .from(planWeeks)
    .where(eq(planWeeks.planVersionId, ctx.versionId))
    .orderBy(asc(planWeeks.week));
  const phases = groupPhases(weekRows);
  const status = planWeekFor(today, ctx.startDate, ctx.weeks);
  const current = status.status === "active" ? weekRows.find((w) => w.week === status.week) : null;

  // The deload that is running or coming next (this week counts).
  const fromWeek =
    status.status === "active" ? status.week : status.status === "finished" ? Infinity : 1;
  const deload = weekRows.find((w) => w.isDeload && w.week >= fromWeek);

  // Next training day: today onwards (weekdays only), within the plan.
  let nextTrainingDay: PlanOverview["nextTrainingDay"] = null;
  if (status.status !== "finished") {
    const first = status.status === "before_start" ? ctx.startDate : today;
    for (let i = 0; i < 10; i += 1) {
      const date = addDays(first, i);
      const weekday = weekdayOf(date);
      const version = ctx.index.versionFor(date) ?? ctx.index.versions[0];
      const s = planWeekFor(date, ctx.startDate, version?.weeks ?? ctx.weeks);
      if (s.status === "finished") break;
      if (weekday && s.status === "active") {
        nextTrainingDay = { date, weekday, focus: DAY_FOCUS[weekday] };
        break;
      }
    }
  }

  return {
    status: status.status,
    startDate: ctx.startDate,
    week: current?.week ?? null,
    phase: current?.phase ?? null,
    weekStart: current?.startDate ?? null,
    weekEnd: current ? addDays(current.startDate, 6) : null,
    phases,
    nextDeload: deload ? { week: deload.week, startDate: deload.startDate } : null,
    nextTrainingDay,
    changes: await loadChanges(db),
  };
}

export type NextItem =
  | {
      kind: "item";
      item: SessionItem;
      extras: SessionItem[];
      /** 1-based position among the day's main items, and how many there are. */
      position: number;
      total: number;
    }
  | { kind: "all_done" | "rest" | "before_start" | "finished" };

/** First open main item of the day (class exposure never counts), with its "+" extras. */
export function nextItem(session: Session, hidden: ReadonlySet<number> = new Set()): NextItem {
  if (session.kind === "rest") return { kind: "rest" };
  if (session.kind === "before_start" || session.kind === "finished") {
    return { kind: session.kind };
  }
  // Items today's readiness level or /short took out of the list are not "next".
  const mains = session.items.filter((i) => i.subItem === 0 && !hidden.has(i.plannedItemId));
  const item = mains.find(
    (i) => i.status === "planned" && !i.options.some((o) => o.slug === "class_exposure"),
  );
  if (!item) return { kind: "all_done" };
  const extras = session.items.filter((e) => e.subItem > 0 && e.itemOrder === item.itemOrder);
  return { kind: "item", item, extras, position: mains.indexOf(item) + 1, total: mains.length };
}
