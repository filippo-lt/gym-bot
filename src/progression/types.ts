/**
 * Shared contract for the progression + fatigue engine (SPEC 5.2, 5.6c, 9).
 * Pure data types only: no DB, no clock. All dates are ISO "YYYY-MM-DD" strings in Europe/Rome;
 * timestamps are ISO strings. The engine gets history passed in and returns plain data.
 */
import type {
  ExerciseType,
  FallbackPrescription,
  HiitSpec,
  LoadBasis,
  Modifier,
  Priority,
  Tag,
  Weekday,
} from "../plan-import/types.js";

export type { ExerciseType, LoadBasis, Modifier, Priority, Tag, Weekday };

export type ReadinessLevel = "GREEN" | "YELLOW" | "RED";
export type HeavyGroup = "pull" | "push" | "legs";

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** One logged set (SPEC 5.2 e1RM). Null = not logged. */
export interface SetRec {
  reps: number | null;
  /** Total/per-hand/stack load for `weighted` exercises (SPEC 5.2 units). */
  loadKg: number | null;
  /** bodyweight_plus: added weight, >= 0. */
  addedKg: number | null;
  /** bodyweight_plus: assistance (band or machine) in kg, >= 0. Resolved from `band` when mapped. */
  assistKg: number | null;
  /** Band colour; if set and not in equipment.bands the set has no load math (unmapped band). */
  band: string | null;
  /** Logged RIR; "4+" is stored as rir 4 + rirPlus true. Null = not answered yet: set is not valid. */
  rir: number | null;
  /** "4+": may raise the e1RM, never lower it (SPEC 5.2). */
  rirPlus: boolean;
  /** Pull-up / HSPU cleanliness; null = unknown. `false` makes the set invalid for e1RM. */
  clean: boolean | null;
  /** Timed items. */
  durationS: number | null;
}

/**
 * One exercise on one session date, log groups merged in set order (SPEC 5.2 session estimate).
 * Imported sessions: the single RIR belongs to the last set (others have rir null), readiness GREEN.
 */
export interface SessionRec {
  date: string;
  exerciseId: number;
  /** Planned items this session covered (break rule, drift). */
  plannedItemIds: number[];
  /** "import" sessions are labelled "estimate" until 2 bot sessions exist (SPEC 5.2). */
  source: "bot" | "import";
  /** bw_kg stored on the log group at log time; never recomputed (SPEC 5.2). */
  bwKg: number | null;
  /** Plan week of the session date (null when outside the plan). */
  week: number | null;
  /** Deload and test weeks are invalid for e1RM and for increases (SPEC 5.2, 9). */
  isDeload: boolean;
  isTest: boolean;
  /** Frozen session readiness; RED sessions are excluded from e1RM (SPEC 5.6c). */
  readiness: ReadinessLevel | null;
  /** Import with per-set data unknown: not valid for e1RM. */
  perSetUnknown: boolean;
  /** HSPU ladder step_order of the step performed (SPEC 5.2 HSPU state). */
  hspuStepOrder: number | null;
  /** HSPU pad height. */
  padHeight: number | null;
  /** The stored suggestion shown for this session (drift compares against it, SPEC 5.6c). */
  suggestion: { id: number; systemLoad: number | null; repsMin: number; rirMid: number } | null;
  sets: SetRec[];
}

// ---------------------------------------------------------------------------
// Exercises, equipment, plan items
// ---------------------------------------------------------------------------

/** Rounding source (SPEC 5.2: equipment is the only source of steps). */
export interface EquipmentRec {
  slug: string;
  /** Empty bar / unloaded sled; barbell totals are base + k * step. */
  baseKg: number | null;
  stepKg: number | null;
  /** Stacks / dumbbell racks: exact allowed values (ascending). */
  discreteValues: number[] | null;
  /** Band colour -> kg of assistance. */
  bands: Record<string, number>;
}

export interface ExerciseInfo {
  id: number;
  slug: string;
  type: ExerciseType;
  /** Null for exercises without load math. */
  loadBasis: LoadBasis | null;
  isMainLift: boolean;
  equipment: EquipmentRec | null;
}

/** A planned item (one option-set) for the session date, flattened for the engine. */
export interface ItemTarget {
  plannedItemId: number;
  subItem: number;
  /** Allowed options (2+ for OR items); history/progression is per option (SPEC 6). */
  exerciseIds: number[];
  setsMin: number | null;
  setsMax: number | null;
  repsMin: number | null;
  repsMax: number | null;
  /** Never parsed from notes (SPEC 5.2 RIR targets). */
  rirMin: number | null;
  rirMax: number | null;
  modifiers: Modifier[];
  tags: Tag[];
  priority: Priority;
  /** Item belongs to a deload week (also the week flag in SessionInput). */
  isDeload: boolean;
  /** Item is a test item ("Clean pull-up TEST"): no load math. */
  isTest: boolean;
  hiit: HiitSpec | null;
  /** Pull-up closed-gate fallback (SPEC 5.2). */
  fallback: FallbackPrescription | null;
  /** HSPU ladder step_order the plan names for this item (null = "current progression"). */
  hspuStepOrder: number | null;
  /** Position within the day (for stable display). */
  order: number;
  /** Raw plan name, for display only. */
  planName: string;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Labels shown next to a suggestion (SPEC 5.2, 5.6, 5.6c). Display text is built in code (src/bot).
 *  - estimate: only 1 valid session (or imported-only) behind the e1RM.
 *  - estimate_check_first_set: imported-only history, "check your first set".
 *  - back_after_break: break rule applied, -10% (SPEC 5.2).
 *  - baseline_ask_load: no valid session yet, load not suggested; `ask: "load"`.
 *  - bw_stale: bodyweight older than 14 days (SPEC 5.6b); also `ask: "bodyweight"`.
 *  - fallback_bw / fallback_assisted: closed pull-up gate fallback, 4 x 4-6 BW or assisted 4 x 6.
 *  - max_test_first: gate not open and no max on record: start with a max-clean test set.
 *  - friday_reduced: Friday auto-regulation, 2 x reps_min at RIR 3-4 (SPEC 5.2).
 *  - friday_offer_skip: item may be skipped (heavy Thursday; unilateral leg; deload Friday).
 *  - readiness_yellow / readiness_red: item adjusted for that level (SPEC 5.6c).
 */
export type Label =
  | "estimate"
  | "estimate_check_first_set"
  | "back_after_break"
  | "baseline_ask_load"
  | "bw_stale"
  | "fallback_bw"
  | "fallback_assisted"
  | "max_test_first"
  | "friday_reduced"
  | "friday_offer_skip"
  | "readiness_yellow"
  | "readiness_red";

export interface Suggestion {
  sets: number;
  repsMin: number;
  repsMax: number;
  rirMin: number;
  rirMax: number;
  /** weighted: rounded load per the exercise's load basis. */
  loadKg?: number;
  /** bodyweight_plus: added weight (>= 0), rounded toward easier. */
  addedKg?: number;
  /** bodyweight_plus: assistance (>= 0), rounded toward easier (more assistance). */
  assistKg?: number;
  /** Band colour chosen for the assistance (smallest band >= needed). */
  band?: string;
  /** bodyweight_plus: bw + added - assist; weighted: loadKg. Used for drift and far-off check (SPEC 5.6d). */
  systemLoad?: number;
  /** The e1RM the load was computed from. */
  e1rmUsed?: number;
  /** RIR mid-point the load was computed at (readiness may override the plan's, SPEC 5.6c). Set by the engine. */
  rirMid?: number;
  labels: Label[];
  /** Set when the load cannot be computed: UI asks the user (SPEC 5.2). */
  ask?: "load" | "bodyweight" | "band";
}

// ---------------------------------------------------------------------------
// Readiness (SPEC 5.6c)
// ---------------------------------------------------------------------------

/**
 * One signal. Expiry: button/chat 24 h, recovery_low 3 days, drift after the next session of that lift.
 * Heavy Thursday is NOT a signal. A `button_strong` cancels chat signals of the same day; `button_ok` adds nothing.
 */
export interface ReadinessSignal {
  /** ISO timestamp. */
  at: string;
  kind:
    | "button_tired"
    | "button_ok"
    | "button_strong"
    | "chat_bad_sleep"
    | "chat_sore"
    | "chat_exhausted"
    | "recovery_low"
    | "drift";
  /** exerciseId, for `drift`. */
  lift?: number;
}

export interface ReadinessResult {
  level: ReadinessLevel;
  /** Signals that counted (after expiry and cancelling), for display/storage. */
  counted: ReadinessSignal[];
}

// ---------------------------------------------------------------------------
// Pull-up gate (SPEC 5.2)
// ---------------------------------------------------------------------------

/** Replayed in date order to derive the gate. */
export type GateEvent =
  /** A logged set: opens at clean BW >= 6. */
  | { kind: "clean_bw_set"; date: string; reps: number }
  /** Check-in / test max (bodyweight): opens at >= 6, closes below 6. */
  | { kind: "test_max"; date: string; reps: number }
  /** A session's own e1RM implies this many BW reps (30 * (e1RM/bw - 1) - 1.5); < 5 twice in a row closes. */
  | { kind: "session_implied"; date: string; reps: number };

export interface GateState {
  open: boolean;
  /** Date the gate last opened. */
  since: string | null;
  /** Last bodyweight max on record (clean reps), for the fallback choice. */
  lastBwMax: number | null;
}

/** Result of `pullupPlan`: what the pull-up item becomes. */
export interface PullupPlan {
  mode: "weighted" | "fallback_bw" | "fallback_assisted";
  /** Start the session with one max-clean test set (no max on record and gate not open). */
  maxTestFirst: boolean;
  sets: number;
  repsMin: number;
  repsMax: number;
  labels: Label[];
  /** Closed gate + no max on record: what the fallback becomes once the max test is done (threshold in clean reps). */
  afterMaxTest?: {
    thresholdReps: number;
    bw: { sets: number; repsMin: number; repsMax: number };
    assisted: { sets: number; repsMin: number; repsMax: number };
  };
}

// ---------------------------------------------------------------------------
// HSPU (SPEC 5.2)
// ---------------------------------------------------------------------------

export interface HspuLadderStep {
  id: number;
  stepOrder: number;
  slug: string;
  name: string;
  defaultSets: number | null;
  defaultRepsMin: number | null;
  defaultRepsMax: number | null;
  tempo: string | null;
}

/** Taken from the last log (SPEC 5.2). Null = never logged. */
export interface HspuState {
  stepOrder: number | null;
  padHeight: number | null;
}

export interface HspuReps {
  sets: number;
  repsMin: number;
  repsMax: number;
  tempo: string | null;
  /** True when the plan's own sets x reps were used (state step == plan step). */
  fromPlan: boolean;
}

/** Proposal to move to the next step after 2 clean non-deload sessions at target (SPEC 5.2). */
export interface HspuAdvanceProposal {
  fromStepOrder: number;
  toStepOrder: number;
}

// ---------------------------------------------------------------------------
// Friday (SPEC 5.2)
// ---------------------------------------------------------------------------

export type FridayAdjustment =
  /** 2 x reps_min at RIR 3-4, or skip. */
  | { kind: "reduce"; sets: 2; reps: number; rirMin: 3; rirMax: 4; skippable: true }
  /** Offer to skip, no reduced prescription (unilateral legs). */
  | { kind: "offer_skip" }
  /** Deload Friday + heavy: 1 easy set or skip. */
  | { kind: "deload_reduce"; sets: 1; skippable: true }
  /** Deload Friday + heavy legs on the unilateral item: skipped. */
  | { kind: "skip" };

// ---------------------------------------------------------------------------
// Engine in/out
// ---------------------------------------------------------------------------

export interface BodyweightRec {
  kg: number;
  date: string;
}

export interface ItemOccurrence {
  plannedItemId: number;
  /** Scheduled dates of this planned item before today (same slot in earlier weeks; deload weeks excluded by caller). */
  occurrences: { date: string; logged: boolean }[];
}

export interface SessionInput {
  /** Session date (not necessarily "now"). */
  date: string;
  weekday: Weekday;
  week: number;
  isDeload: boolean;
  isTest: boolean;
  items: ItemTarget[];
  /** Per exerciseId, newest first. */
  history: Record<number, SessionRec[]>;
  exercises: Record<number, ExerciseInfo>;
  /** Latest bodyweight; "bw_stale" when older than 14 days (SPEC 5.6b). */
  bodyweight: BodyweightRec | null;
  gateEvents: GateEvent[];
  hspuLadder: HspuLadderStep[];
  /** Thursday heavy groups (class_logs.heavy_groups); empty when not heavy or not reported. */
  heavyGroups: HeavyGroup[];
  /** True when Thursday's class was reported (Friday asks first otherwise). */
  classReported: boolean;
  /** All signals still relevant; the engine applies expiry. */
  readinessSignals: ReadinessSignal[];
  /** Level already frozen for this session (SPEC 5.6c); engine uses it instead of recomputing. */
  frozenLevel: ReadinessLevel | null;
  /** /short: hide Low, flag Medium (SPEC 5.2). */
  short: boolean;
  /** Last day with any logged training before `date` (break rule: 10+ days). */
  lastTrainingDate: string | null;
  /** Per plannedItemId occurrences for the missed-twice break rule. */
  occurrences: ItemOccurrence[];
}

export interface AdjustedItem {
  target: ItemTarget;
  /** Per option exerciseId; null = no suggestion (no load math, or ask). */
  suggestions: Record<number, Suggestion | null>;
  /** Convenience: suggestion for the only/first option. */
  suggestion: Suggestion | null;
  /** Removed by readiness / short / Friday skip. Not shown unless asked. */
  hidden: boolean;
  /** Medium item under /short, or an optional item. */
  optional: boolean;
  /** User may skip (Friday offer_skip, reduce, deload_reduce). */
  skipOffer: boolean;
  friday: FridayAdjustment | null;
  /** Sets x reps x RIR actually prescribed after all adjustments. */
  prescription: {
    sets: number | null;
    repsMin: number | null;
    repsMax: number | null;
    rirMin: number | null;
    rirMax: number | null;
  };
  /** HIIT after halving (YELLOW) or removal (RED -> hidden). */
  hiit: HiitSpec | null;
  /** Pull-up plan (gate/fallback/max-test) when the item is the pull-up. */
  pullup: PullupPlan | null;
  /** HSPU reps decision when the item is skill_ladder. */
  hspu: HspuReps | null;
  /** HSPU advance proposal for the engine's caller to persist as a proposal. */
  hspuAdvance: HspuAdvanceProposal | null;
}

export interface AdjustedSession {
  date: string;
  level: ReadinessLevel;
  levelSignals: ReadinessSignal[];
  /** Items in plan order, including hidden ones (flag). */
  items: AdjustedItem[];
  /** Friday with nothing left (RED) -> suggest a rest day (SPEC 5.6c). */
  restDaySuggested: boolean;
  /** Friday and Thursday class not reported yet: ask first (SPEC 5.2). */
  askClassFirst: boolean;
  /** Test week: results go to metrics, no e1RM updates. */
  isTest: boolean;
  /** Bodyweight too old/missing for a pull-up suggestion (SPEC 5.6b). */
  needsBodyweight: boolean;
  /** Date of the bodyweight the pull-up suggestions used ("BW from <date>"), null when none. */
  bodyweightDate?: string | null;
  /** RED on a Thursday: "go easy in class or skip it" (SPEC 5.6c). */
  classAdvice?: boolean;
}
