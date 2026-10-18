import type { plannedItems } from "../db/schema/plan.js";
import type { Weekday } from "../plan-import/types.js";

export type PlanChange =
  | { kind: "swap"; from: number; to: number; weekdays: Weekday[] | "all"; fromDate: string }
  | { kind: "deload_earlier"; insertedWeek: number; droppedWeek: number | null };

export interface WeekSpec {
  week: number;
  phase: string;
  isDeload: boolean;
  isTest: boolean;
  startDate: string;
}

/** A planned_items row without id/planVersionId, plus its options in option_index order. */
export type ItemSpec = Omit<typeof plannedItems.$inferSelect, "id" | "planVersionId"> & {
  optionExerciseIds: number[];
};

export interface PlanContent {
  weeks: WeekSpec[];
  items: ItemSpec[];
}
