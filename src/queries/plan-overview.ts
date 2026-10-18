/** Read-only plan facts for /plan and /next. */
import { asc, eq } from "drizzle-orm";
import type { Session, SessionItem } from "../bot/session.js";
import { DAY_FOCUS } from "../bot/session.js";
import { planWeeks } from "../db/schema/plan.js";
import type { Db } from "../db/seed-plan.js";
import { planWeekFor, weekdayOf } from "../domain/calendar.js";
import { addDays, loadPlanContext } from "../logging/plan-context.js";
import type { Weekday } from "../plan-import/types.js";

export interface PlanPhase {
  fromWeek: number;
  toWeek: number;
  phase: string;
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
