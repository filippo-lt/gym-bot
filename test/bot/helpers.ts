import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DAY_FOCUS,
  type HeavyGroup,
  type ItemStatus,
  type Session,
  type SessionItem,
  type WeekDay,
  type WeekOverview,
} from "../../src/bot/session.js";
import type { ParsedPlan, Weekday } from "../../src/plan-import/types.js";

export const plan: ParsedPlan = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../seed/plan.parsed.json"), "utf8"),
);

const ladder = new Map(plan.hspu_ladder.map((h) => [h.slug, h.name]));
const names = new Map(plan.exercises.map((e) => [e.slug, e.name]));

export function sessionFor(
  week: number,
  weekday: Weekday,
  date: string,
  opts: {
    thursday?: Extract<Session, { kind: "session" }>["thursday"];
    status?: Record<string, ItemStatus>;
  } = {},
): Extract<Session, { kind: "session" }> {
  const w = plan.weeks.find((x) => x.week === week);
  if (!w) throw new Error(`no week ${week}`);
  const items: SessionItem[] = plan.items
    .filter((i) => i.week === week && i.weekday === weekday)
    .sort((a, b) => a.order - b.order || a.sub_item - b.sub_item)
    .map((i) => ({
      plannedItemId: 0,
      itemOrder: i.order,
      subItem: i.sub_item,
      block: i.block,
      planName: i.plan_name,
      variantLabel: i.variant_label,
      options: i.exercise_options.map((slug) => ({ slug, name: names.get(slug) ?? slug })),
      prescriptionRaw: i.prescription_raw,
      extrasRaw: i.extras_raw,
      setsMin: i.sets_min,
      setsMax: i.sets_max,
      repsMin: i.reps_min,
      repsMax: i.reps_max,
      perSide: i.per_side,
      durationSMin: i.duration_s_min,
      durationSMax: i.duration_s_max,
      hiit: i.hiit,
      tempo: i.tempo,
      modifiers: i.modifiers,
      hspuStep: i.hspu_step ? (ladder.get(i.hspu_step) ?? null) : null,
      rirMin: i.rir_min,
      rirMax: i.rir_max,
      tags: i.tags,
      priority: i.priority,
      note: i.note,
      timeMinMin: i.time_min_min,
      timeMinMax: i.time_min_max,
      fallback: i.fallback_prescription,
      status: opts.status?.[i.key] ?? "planned",
    }));
  const s: Extract<Session, { kind: "session" }> = {
    kind: "session",
    date,
    week,
    phase: w.phase,
    isDeload: w.is_deload,
    isTest: w.is_test,
    weekday,
    focus: DAY_FOCUS[weekday],
    items,
  };
  if (opts.thursday !== undefined) s.thursday = opts.thursday;
  return s;
}

export function weekFor(
  week: number,
  counts: Partial<Record<Weekday, Partial<WeekDay>>> = {},
): Extract<WeekOverview, { kind: "week" }> {
  const w = plan.weeks.find((x) => x.week === week);
  if (!w) throw new Error(`no week ${week}`);
  const order: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
  return {
    kind: "week",
    week,
    phase: w.phase,
    isDeload: w.is_deload,
    isTest: w.is_test,
    startDate: w.start_date,
    days: order.map((weekday, i) => {
      const total = plan.items.filter(
        (x) => x.week === week && x.weekday === weekday && x.sub_item === 0,
      ).length;
      const date = new Date(`${w.start_date}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + i);
      return {
        date: date.toISOString().slice(0, 10),
        weekday,
        focus: DAY_FOCUS[weekday],
        total,
        done: 0,
        skipped: 0,
        modified: 0,
        ...counts[weekday],
      };
    }),
  };
}

export type { HeavyGroup };
