import type { Weekday } from "../plan-import/types.js";

export type PlanChange =
  | { kind: "swap"; from: number; to: number; weekdays: Weekday[] | "all"; fromDate: string }
  | { kind: "deload_earlier"; insertedWeek: number; droppedWeek: number | null };
