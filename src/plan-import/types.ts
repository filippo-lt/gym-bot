export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri";

export type ExerciseType =
  | "weighted"
  | "bodyweight_plus"
  | "bodyweight_reps"
  | "skill_ladder"
  | "timed"
  | "distance"
  | "skill_practice"
  | "hiit"
  | "mobility"
  | "warmup"
  | "class"
  | "recovery";

export type LoadBasis = "barbell_total" | "per_hand" | "stack" | "bodyweight_plus";

export type Tag =
  | "skill_strength"
  | "skill_practice"
  | "vertical_pull"
  | "vertical_press"
  | "horizontal_press"
  | "row"
  | "hinge"
  | "squat"
  | "unilateral_leg"
  | "core"
  | "accessory"
  | "prehab"
  | "hiit"
  | "mobility"
  | "warmup"
  | "recovery"
  | "class";

export type Modifier =
  | "easy"
  | "light"
  | "optional"
  | "heavy_clean"
  | "slightly_heavier"
  | "test"
  | "deload"
  | "max_attempts"
  | "stop_before_form_breaks";

export type Priority = "PRIMARY" | "High" | "Important" | "Medium" | "Low" | "Prep" | "Recovery";

export type ParseFlagCode =
  | "unparsed_text"
  | "missing_sets"
  | "missing_reps"
  | "max_reps"
  | "optional_extra"
  | "hspu_step_from_state"
  | "unknown_exercise"
  | "or_option_unclear";

export interface ParseFlag {
  code: ParseFlagCode;
  detail: string;
}

export interface CatalogExercise {
  slug: string;
  name: string;
  aliases: string[];
  muscle_group: string;
  type: ExerciseType;
  load_basis: LoadBasis | null;
  equipment_slug: string | null;
  is_main_lift: boolean;
  /** Set when a catalog choice needs the user's confirmation in the review. */
  review_note: string | null;
}

export interface Equipment {
  slug: string;
  name: string;
  /** Empty bar / unloaded sled weight; only for equipment whose load includes it. */
  base_kg: number | null;
  step_kg: number | null;
  discrete_values: number[] | null;
  /** Band colour → kg of assistance. */
  bands: Record<string, number> | null;
}

export interface HspuStep {
  slug: string;
  name: string;
  order: number;
  default_sets: number | null;
  default_reps_min: number | null;
  default_reps_max: number | null;
  tempo: string | null;
}

export interface SetsReps {
  sets: number;
  reps_min: number;
  reps_max: number;
}

export interface FallbackPrescription {
  /** Applies while the weighted pull-up gate is closed. */
  if_bw_max_gte: number;
  then: SetsReps & { mode: "bodyweight" };
  else: SetsReps & { mode: "assisted" };
}

export interface HiitSpec {
  rounds: number;
  work_s: number;
  rest_s: number;
}

export interface ParsedItem {
  /** Stable id, e.g. "w01-mon-02-0" (week, weekday, order, sub_item). */
  key: string;
  week: number;
  weekday: Weekday;
  order: number;
  /** 0 = main item; 1+ = extra parsed from the prescription (e.g. "+ 1 easy BW set"). */
  sub_item: number;
  block: string;
  plan_name: string;
  /** Canonical exercise slugs; 2+ only for whitelisted OR items. */
  exercise_options: string[];
  variant_label: string | null;
  prescription_raw: string;
  extras_raw: string | null;
  sets_min: number | null;
  sets_max: number | null;
  reps_min: number | null;
  reps_max: number | null;
  per_side: boolean;
  duration_s_min: number | null;
  duration_s_max: number | null;
  hiit: HiitSpec | null;
  tempo: string | null;
  modifiers: Modifier[];
  hspu_step: string | null;
  rir_min: number | null;
  rir_max: number | null;
  tags: Tag[];
  rest_raw: string;
  priority: Priority;
  note: string | null;
  time_raw: string;
  time_min_min: number | null;
  time_min_max: number | null;
  fallback_prescription: FallbackPrescription | null;
  flags: ParseFlag[];
}

export interface ParsedWeek {
  week: number;
  phase: string;
  is_deload: boolean;
  is_test: boolean;
  /** ISO date of the week's Monday. */
  start_date: string;
}

export interface ParsedPlan {
  /** sha256 of the raw plan file bytes. */
  source_hash: string;
  name: string;
  start_date: string;
  weeks_count: number;
  weeks: ParsedWeek[];
  exercises: CatalogExercise[];
  equipment: Equipment[];
  hspu_ladder: HspuStep[];
  items: ParsedItem[];
}

/** Field values the user sets for a flagged item; any ParsedItem field except identity fields. */
export type ItemOverride = Partial<
  Omit<ParsedItem, "key" | "week" | "weekday" | "order" | "sub_item" | "flags">
> & {
  /** Flag codes on this item that the user marks as resolved. */
  resolve: ParseFlagCode[];
  comment?: string;
};

/** The user's answer to a catalog review_note; clears the note. */
export type ExerciseOverride = Partial<
  Pick<CatalogExercise, "type" | "load_basis" | "equipment_slug" | "muscle_group">
> & {
  acknowledge: true;
  comment?: string;
};

export interface PlanOverrides {
  /** Hash of the plan file these overrides were written against. */
  source_hash: string;
  items: Record<string, ItemOverride>;
  exercises?: Record<string, ExerciseOverride>;
}

export interface OpenIssue {
  scope: "plan" | "item" | "equipment" | "hspu_ladder" | "exercise";
  ref: string;
  detail: string;
}

export interface ResolvedPlan {
  plan: ParsedPlan;
  /** sha256 of the canonical resolved content (weeks, items, exercises, ladder); detects override changes after seeding. */
  resolved_hash: string;
  /** Empty = safe to seed. */
  open_issues: OpenIssue[];
}
