import type { Weekday } from "../plan-import/types.js";

export type SessionStatus = "planned" | "done" | "modified" | "skipped";

export interface HistoryIssue {
  code: string;
  /** Record slug like "w01-tue-05", or "overrides" / "export". */
  ref: string;
  detail: string;
  /** Ready-to-paste fix for the overrides file. */
  snippet?: string;
}

export interface SessionItemRow {
  import_row_key: string;
  session_date: string;
  item_key: string;
  week: number;
  status: Exclude<SessionStatus, "planned">;
  chosen_exercise_slug: string | null;
}

export interface LogEntryRow {
  set_index: number;
  reps: number | null;
  load_kg: number | null;
  added_kg: number | null;
  assist_kg: number | null;
  duration_s: number | null;
  distance_m: number | null;
  pad_height: number | null;
  rir: number | null;
  rir_plus: boolean;
  clean: boolean | null;
  note: string | null;
}

export interface LogGroupRow {
  import_row_key: string;
  session_date: string;
  /** ISO instant (UTC) of 12:00 Europe/Rome on session_date. */
  performed_at: string;
  item_key: string;
  week: number;
  sub_item: 0;
  exercise_slug: string;
  bw_kg: number | null;
  readiness_level: "GREEN";
  source: "import";
  per_set_unknown: boolean;
  entries: LogEntryRow[];
}

export interface ClassLogRow {
  date: string;
  week: number;
  heavy_groups: string[];
  source: "import";
}

export interface WeeklyMetricRow {
  plan_week: number;
  metric: string;
  value_num: number | null;
  value_text: string | null;
  unit: string | null;
  source: "import";
  import_row_key: string;
}

export interface BodyweightRow {
  date: string;
  kg: number;
  source: "import";
}

export interface ReviewRow {
  key: string;
  date: string;
  week: number;
  weekday: Weekday;
  plan_exercise: string;
  /** Chosen exercise slug, or null while an OR item is still open. */
  chosen: string | null;
  raw: { actual: string; load: string; rir: string; notes: string };
  sets_text: string;
  load_text: string;
  rir_text: string;
  flags: string[];
}

export interface HistoryImport {
  export_hash: string;
  session_items: SessionItemRow[];
  log_groups: LogGroupRow[];
  class_logs: ClassLogRow[];
  weekly_metrics: WeeklyMetricRow[];
  bodyweight: BodyweightRow | null;
  review_rows: ReviewRow[];
  open_issues: HistoryIssue[];
}

export interface HistoryOverrideRecord {
  chosen_option?: string;
  sets?: number[];
  load_kg_total?: number;
  comment?: string;
}

export interface HistoryOverrides {
  export_hash: string;
  bodyweight: { date: string; kg: number } | null;
  records: Record<string, HistoryOverrideRecord>;
}
