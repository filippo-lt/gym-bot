import { addDays } from "../plan-import/build-plan.js";
import type { Weekday } from "../plan-import/types.js";
import type { ItemSpec, PlanContent } from "./types.js";

const WEEKDAY_OFFSET: Record<Weekday, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };

/** Calendar date (yyyy-mm-dd) of an item: its week's start date plus the weekday offset. */
export function itemDate(content: PlanContent, item: ItemSpec): string {
  const week = content.weeks.find((w) => w.week === item.week);
  if (!week) throw new Error(`Week ${item.week} not in plan content`);
  return addDays(week.startDate, WEEKDAY_OFFSET[item.weekday]);
}

export interface SwapSpec {
  fromExerciseId: number;
  toExerciseId: number;
  fromDate: string;
  weekdays: Weekday[] | "all";
  clearHspuStep: boolean;
  /**
   * Whether the new options include a bodyweight_plus exercise. A changed item without one drops its
   * fallback prescription (it was written for a pull-up). Omitted: the fallback is kept.
   */
  hasBodyweightPlus?: (newOptionIds: number[]) => boolean;
  /** Recomputes RIR for a changed item from its new options (called only for changed items). */
  rirFor: (
    item: ItemSpec,
    newOptionIds: number[],
    weekIsDeload: boolean,
  ) => { rirMin: number | null; rirMax: number | null };
}

/** Replace one option (not the whole OR item) on items dated on/after fromDate. */
export function applySwap(
  content: PlanContent,
  s: SwapSpec,
): { content: PlanContent; changedItems: number } {
  let changedItems = 0;
  const items = content.items.map((item) => {
    if (!item.optionExerciseIds.includes(s.fromExerciseId)) return item;
    if (s.weekdays !== "all" && !s.weekdays.includes(item.weekday)) return item;
    if (itemDate(content, item) < s.fromDate) return item;
    const mapped = item.optionExerciseIds.map((id) =>
      id === s.fromExerciseId ? s.toExerciseId : id,
    );
    const optionExerciseIds = mapped.filter((id, i) => mapped.indexOf(id) === i);
    changedItems++;
    const week = content.weeks.find((w) => w.week === item.week);
    const { rirMin, rirMax } = s.rirFor(item, optionExerciseIds, week?.isDeload ?? false);
    return {
      ...item,
      optionExerciseIds,
      rirMin,
      rirMax,
      hspuStepId: s.clearHspuStep ? null : item.hspuStepId,
      fallbackPrescription:
        s.clearHspuStep || s.hasBodyweightPlus?.(optionExerciseIds) === false
          ? null
          : item.fallbackPrescription,
    };
  });
  return { content: { weeks: content.weeks, items }, changedItems };
}
