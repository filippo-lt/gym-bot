/**
 * M3 contract shared by the logging domain (src/logging), the AI layer (src/ai) and the bot.
 * Claude's write tools only *stage* actions; code decides whether to write now or ask first
 * (SPEC 5.6d). Every number shown to the user comes from code, never from the model.
 */
import { z } from "zod";
import type { ExerciseType, LoadBasis, Priority, Weekday } from "../plan-import/types.js";

/** Where a staged input came from (pending_actions.input_source). */
export type InputSource = "text" | "voice" | "photo";

export const DAY_VALUES = ["today", "mon", "tue", "wed", "thu", "fri"] as const;
export type Day = (typeof DAY_VALUES)[number];

const kg = z.number().min(0).max(500);

/** One set as the user said it. Unit conversion happens in code (SPEC 5.2). */
export const setInputSchema = z.strictObject({
  reps: z.number().int().min(0).max(1000).optional(),
  /** In the exercise's convention: barbell total incl. bar, dumbbell per hand, stack value. */
  load_kg: kg.optional(),
  /** Barbell only: plates on each side; code adds the bar (equipment.base_kg). */
  plates_per_side_kg: kg.optional(),
  /** Dumbbells only: both dumbbells together; code halves it. */
  pair_total_kg: kg.optional(),
  /** Pull-up type: extra weight. */
  added_kg: kg.optional(),
  /** Pull-up type: assistance in kg. */
  assist_kg: kg.optional(),
  /** Band colour as said ("red"). Code maps it to kg through equipment.bands; unmapped = no load math. */
  band: z.string().min(1).max(30).optional(),
  duration_s: z.number().int().min(0).max(36_000).optional(),
  distance_m: z.number().min(0).max(100_000).optional(),
  pad_height: z.number().min(0).max(100).optional(),
  rir: z.number().int().min(0).max(10).optional(),
  /** "4+" = rir 4 with rir_plus. */
  rir_plus: z.boolean().optional(),
});
export type SetInput = z.infer<typeof setInputSchema>;

export const uniformSetsSchema = setInputSchema.extend({
  count: z.number().int().min(1).max(20),
});
export type UniformSets = z.infer<typeof uniformSetsSchema>;

export const rirValueSchema = z.union([z.number().int().min(0).max(10), z.literal("4+")]);

export const logSetsInputSchema = z.strictObject({
  exercise: z.strictObject({
    /** Catalog slug when the model is sure; omit when unsure. */
    slug: z.string().min(1).max(60).optional(),
    /** The words the user used, e.g. "fp". Used for aliases and fuzzy matching. */
    said: z.string().min(1).max(100),
  }),
  /**
   * Omit unless the user named a day. "today" only when the user says it was today or rejects an
   * earlier day (no make-up of an earlier planned session is then proposed); a weekday when named.
   */
  day: z.enum(DAY_VALUES).optional(),
  /** Either one object per set, or a uniform block {count, reps, load_kg, ...}. */
  sets: z.union([z.array(setInputSchema).min(1).max(20), uniformSetsSchema]),
  /** One RIR for the whole group belongs to the last set (SPEC 5.2). */
  rir: rirValueSchema.optional(),
  /** Pull-up / HSPU: applies to every set of the group. */
  clean: z.boolean().optional(),
  /** HSPU only: ladder step slug (hspu_ladder.slug). Omit when not said; code uses the last logged step. */
  hspu_step: z.string().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
  /** Field names the model filled in without the user saying them, e.g. ["sets"]. */
  guessed_fields: z.array(z.string().max(40)).max(20).default([]),
  needs_confirmation: z.boolean().default(false),
});
export type LogSetsInput = z.infer<typeof logSetsInputSchema>;

export const editLastInputSchema = z.strictObject({
  /** 1-based set numbers; omit to mean every set (allowed only when they share one load). */
  set_indexes: z.array(z.number().int().min(1).max(20)).min(1).max(20).optional(),
  changes: setInputSchema.omit({ rir_plus: true }).extend({
    rir: rirValueSchema.optional(),
    clean: z.boolean().optional(),
    exercise_slug: z.string().min(1).max(60).optional(),
    hspu_step: z.string().min(1).max(60).optional(),
    note: z.string().max(500).optional(),
  }),
  guessed_fields: z.array(z.string().max(40)).max(20).default([]),
  needs_confirmation: z.boolean().default(false),
});
export type EditLastInput = z.infer<typeof editLastInputSchema>;

export const skipItemsInputSchema = z
  .strictObject({
    /** One planned exercise to skip; code finds the matching open item of that day. */
    exercise: z
      .strictObject({
        slug: z.string().min(1).max(60).optional(),
        said: z.string().min(1).max(100),
      })
      .optional(),
    /** Skip every open item of the day. */
    whole_session: z.boolean().optional(),
    /** Omit unless the user named a weekday. */
    day: z.enum(DAY_VALUES).optional(),
  })
  .refine((v) => (v.exercise !== undefined) !== (v.whole_session === true), {
    message: "Give exactly one of exercise or whole_session: true.",
  });
export type SkipItemsInput = z.infer<typeof skipItemsInputSchema>;

export const undoLastInputSchema = z.strictObject({});
export type UndoLastInput = z.infer<typeof undoLastInputSchema>;

export const READINESS_SIGNALS = ["bad_sleep", "sore", "exhausted", "good"] as const;
export const logReadinessInputSchema = z.strictObject({
  /** What the user said about today. "good" only when they explicitly say they feel great (it cancels the day's chat signals). */
  signal: z.enum(READINESS_SIGNALS),
});
export type LogReadinessInput = z.infer<typeof logReadinessInputSchema>;

export const logBodyweightInputSchema = z.strictObject({
  kg: z.number().min(20).max(400),
});
export type LogBodyweightInput = z.infer<typeof logBodyweightInputSchema>;

export const HEAVY_GROUP_VALUES = ["pull", "push", "legs"] as const;
export const logClassInputSchema = z.strictObject({
  /** Groups the Thursday class loaded heavily; empty = not heavy. */
  heavy_groups: z.array(z.enum(HEAVY_GROUP_VALUES)).max(3),
});
export type LogClassInput = z.infer<typeof logClassInputSchema>;

export const setBandKgInputSchema = z.strictObject({
  /** Band colour as said ("red"). */
  colour: z.string().trim().min(1).max(30),
  kg: z.number().min(0).max(200),
});
export type SetBandKgInput = z.infer<typeof setBandKgInputSchema>;

/** Read-only day names: also yesterday/tomorrow, which log_sets does not accept. */
export const READ_DAY_VALUES = [
  "today",
  "yesterday",
  "tomorrow",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type ReadDay = (typeof READ_DAY_VALUES)[number];

export const getSessionInputSchema = z
  .strictObject({
    /** A day the user named. Omit both day and date for today. */
    day: z.enum(READ_DAY_VALUES).optional(),
    /** A calendar date the user gave, YYYY-MM-DD. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
      .optional(),
  })
  .refine((v) => !(v.day !== undefined && v.date !== undefined), {
    message: "Give either day or date, not both.",
  });
export type GetSessionInput = z.infer<typeof getSessionInputSchema>;

export const HISTORY_PERIODS = ["this_week", "last_week"] as const;
export const HISTORY_DEFAULT_LAST_N = 5;

export const getExerciseHistoryInputSchema = z
  .strictObject({
    exercise: z.strictObject({
      slug: z.string().min(1).max(60).optional(),
      said: z.string().min(1).max(100),
    }),
    /** How many sessions, newest first. Default 5. */
    last_n: z.number().int().min(1).max(10).optional(),
    /** Calendar week of today. Code turns it into dates. */
    period: z.enum(HISTORY_PERIODS).optional(),
    /** A week of the 12-week plan. */
    plan_week: z.number().int().min(1).max(12).optional(),
  })
  .refine((v) => !(v.period !== undefined && v.plan_week !== undefined), {
    message: "Give either period or plan_week, not both.",
  });
export type GetExerciseHistoryInput = z.infer<typeof getExerciseHistoryInputSchema>;

export const getAlternativesInputSchema = z.strictObject({
  exercise: z.strictObject({
    slug: z.string().min(1).max(60).optional(),
    said: z.string().min(1).max(100),
  }),
  /** What the user wants, in their words, e.g. "machine version". */
  want: z.string().max(100).optional(),
});
export type GetAlternativesInput = z.infer<typeof getAlternativesInputSchema>;

export const MEMORY_KINDS = ["limitation", "preference"] as const;
export const MEMORY_CONTENT_MAX = 200;

export const saveMemoryInputSchema = z.strictObject({
  kind: z.enum(MEMORY_KINDS),
  /** The lasting fact, short, in the user's meaning. */
  content: z.string().trim().min(1).max(MEMORY_CONTENT_MAX),
});
export type SaveMemoryInput = z.infer<typeof saveMemoryInputSchema>;

// ---------------------------------------------------------------------------
// Resolved data (produced by src/logging, consumed by policy, executor, formatters)

export interface EquipmentInfo {
  slug: string;
  baseKg: number | null;
  stepKg: number | null;
  discreteValues: number[] | null;
  /** Band colour -> kg of assistance (pull-up equipment). */
  bands?: Record<string, number>;
}

export interface ResolvedExercise {
  id: number;
  slug: string;
  name: string;
  type: ExerciseType;
  loadBasis: LoadBasis | null;
  isMainLift: boolean;
  /** True for pull-up and HSPU (skill_strength): clean is asked when missing. */
  needsClean: boolean;
  equipment: EquipmentInfo | null;
}

/** One set in DB units, 1-based setIndex. */
export interface ResolvedEntry {
  setIndex: number;
  reps: number | null;
  loadKg: number | null;
  addedKg: number | null;
  assistKg: number | null;
  durationS: number | null;
  distanceM: number | null;
  padHeight: number | null;
  rir: number | null;
  rirPlus: boolean;
  clean: boolean | null;
  note: string | null;
  /** Band colour; assistKg is null while the colour has no kg mapping. */
  band: string | null;
}

export interface PlannedItemInfo {
  id: number;
  subItem: number;
  week: number;
  weekday: Weekday;
  planName: string;
  priority: Priority;
  setsMin: number | null;
  setsMax: number | null;
  repsMin: number | null;
  repsMax: number | null;
  rirMin: number | null;
  rirMax: number | null;
  isDeload: boolean;
}

/** The last logged session of the same exercise, for the far-off check. */
export interface LastSessionRef {
  sessionDate: string;
  /** Highest system load among its sets (load_kg, or bw + added − assist); null if none. */
  maxSystemLoad: number | null;
  bestReps: number | null;
}

export type MatchKind = "today" | "makeup" | "unplanned";

export interface ResolvedLog {
  said: string;
  exercise: ResolvedExercise;
  /** Planned date (make-ups keep the planned date; performed_at is the real time). */
  sessionDate: string;
  match: MatchKind;
  plannedItem: PlannedItemInfo | null;
  /** HSPU ladder step (SPEC 5.2: the step is user state taken from the last log). */
  hspuStep: Candidate | null;
  entries: ResolvedEntry[];
  bwKg: number | null;
  note: string | null;
  /** Required fields that are missing, e.g. ["reps"], ["load"], ["duration"]. */
  missingFields: string[];
  guessedFields: string[];
  needsConfirmation: boolean;
  lastSession: LastSessionRef | null;
  /** System load of the stored suggestion for this item/option (SPEC 5.6d far-off reference); null = none. */
  suggestedSystemLoad?: number | null;
}

export interface Candidate {
  slug: string;
  name: string;
}

/** A snapshot of a stored group, used for edit before/after, delete cards and undo. */
export interface GroupSnapshot {
  groupId: number;
  sessionDate: string;
  performedAt: string;
  exercise: {
    id: number;
    slug: string;
    name: string;
    type: ExerciseType;
    loadBasis: LoadBasis | null;
    equipment: EquipmentInfo | null;
  };
  plannedItemId: number | null;
  hspuStep: Candidate | null;
  bwKg: number | null;
  entries: ResolvedEntry[];
}

/** A planned item to mark skipped. */
export interface SkipTarget {
  plannedItemId: number;
  planName: string;
  priority: Priority;
}

export type StagedAction =
  | { kind: "log_sets"; input: LogSetsInput; resolved: ResolvedLog }
  /** The exercise is unclear: the bot asks with buttons before anything else. */
  | { kind: "clarify_exercise"; input: LogSetsInput; said: string; candidates: Candidate[] }
  | {
      kind: "edit_group";
      input: EditLastInput;
      before: GroupSnapshot;
      after: GroupSnapshot;
      /** 1-based sets that change. */
      setIndexes: number[];
      /** Same far-off reference as logging, against the edited values. */
      lastSession: LastSessionRef | null;
      /** The planned item's reps_max: the far-off reps fallback when there is no last session. */
      plannedRepsMax?: number | null;
      /** System load of the suggestion the group was logged against, if any. */
      suggestedSystemLoad?: number | null;
    }
  | { kind: "delete_group"; snapshot: GroupSnapshot }
  /** A lasting limitation/preference. Always goes through a confirm card (SPEC 5.6e). */
  | { kind: "save_memory"; input: SaveMemoryInput }
  /** Band colour -> kg: it changes equipment, so it always goes through a confirm card. */
  | {
      kind: "set_band_kg";
      input: SetBandKgInput;
      /** Equipment the mapping is written to (the pull-up equipment). */
      equipmentSlug: string;
      previousKg: number | null;
    }
  | {
      kind: "log_readiness";
      input: LogReadinessInput;
      date: string;
      /** /readiness tap (t tired, o ok, s strong): `input.signal` is then only the nearest chat word. */
      button?: "t" | "o" | "s";
    }
  | { kind: "log_bodyweight"; input: LogBodyweightInput; date: string }
  | { kind: "log_class"; input: LogClassInput; date: string }
  /** Marks planned items skipped; a PRIMARY item or the whole session goes through a card. */
  | {
      kind: "skip_items";
      sessionDate: string;
      whole: boolean;
      items: SkipTarget[];
      /** The date is not today: needs a card (SPEC 5.6d). */
      otherDay?: boolean;
      /** Several open items fit the words; the first was taken. */
      ambiguous?: boolean;
    };

/** What a staging call returns to the AI loop. `preview` is shown to the model as the tool result. */
export type StageResult =
  | { ok: true; action: StagedAction; preview: string }
  | { ok: false; error: string };

/**
 * What a read tool returns. `facts` is sent to the model as JSON; `fallbackHtml` is the
 * code-formatted answer the bot sends when the model's reply fails the number guard.
 */
export interface ReadResult {
  facts: unknown;
  fallbackHtml: string | null;
  /** The input was refused (e.g. an unknown date): reported to the model, not a staging error. */
  isError?: boolean;
}

/** The tools' backend, injected into the AI loop (DB-backed in production, fake in tests). */
export interface LoggingBackend {
  getSession(input: GetSessionInput): Promise<ReadResult>;
  getExerciseHistory(input: GetExerciseHistoryInput): Promise<ReadResult>;
  getAlternatives(input: GetAlternativesInput): Promise<ReadResult>;
  stageSaveMemory(input: SaveMemoryInput): Promise<StageResult>;
  stageReadiness(input: LogReadinessInput): Promise<StageResult>;
  stageBodyweight(input: LogBodyweightInput): Promise<StageResult>;
  stageClass(input: LogClassInput): Promise<StageResult>;
  stageBandKg(input: SetBandKgInput): Promise<StageResult>;
  stageLogSets(input: LogSetsInput): Promise<StageResult>;
  stageEdit(input: EditLastInput): Promise<StageResult>;
  stageUndoLast(input: UndoLastInput): Promise<StageResult>;
  stageSkip(input: SkipItemsInput): Promise<StageResult>;
}

// ---------------------------------------------------------------------------
// Policy

export type ConfirmReason =
  | "multiple_writes"
  | "not_in_today"
  | "makeup"
  | "missing_field"
  | "guessed"
  | "model_flag"
  | "load_far_off"
  | "reps_far_off"
  | "delete"
  | "skip_primary"
  | "skip_session"
  | "skip_ambiguous"
  /** A limitation/preference is never saved without a tap (SPEC 5.6e). */
  | "memory"
  /** Band kg changes the equipment table: always a tap. */
  | "equipment"
  /** An unsaved request is open: new actions replace it through a card, never a direct write. */
  | "replaces_pending"
  /** A tool call failed while others were staged: part of the message was not understood. */
  | "partly_understood";

export type PolicyDecision =
  | { mode: "direct" }
  | { mode: "clarify"; index: number }
  | { mode: "confirm"; reasons: ConfirmReason[] };

// ---------------------------------------------------------------------------
// Ledger results (write_ledger.result jsonb)

/** Group-level fields an edit may change, kept so Undo restores them too. */
export interface BeforeGroup {
  exerciseId: number;
  plannedItemId: number | null;
  subItem: number;
  hspuStepId: number | null;
  note: string | null;
}

/** A session_items row as it was before a bot write touched it (null = there was no row). */
export interface SessionItemBefore {
  status: "planned" | "done" | "modified" | "skipped";
  chosenExerciseId: number | null;
  source: "bot" | "import";
}

export type LedgerResult =
  | {
      kind: "log";
      groupId: number;
      /** The planned item the log marked done (the state below belongs to it). */
      plannedItemId?: number | null;
      /** Undo restores this; absent on legacy rows. */
      sessionItemBefore?: SessionItemBefore | null;
      /** Telegram id of the echo sent for a direct write, so a later edit can refresh it. */
      messageId?: number;
    }
  | {
      kind: "edit";
      groupId: number;
      /** State of the new planned item's row before an edit moved the group onto it. */
      sessionItemBefore?: SessionItemBefore | null;
      before: ResolvedEntry[];
      beforeGroup?: BeforeGroup;
      /** Values written by the edit: Undo only restores while these are still current. */
      after?: ResolvedEntry[];
      afterGroup?: BeforeGroup;
    }
  | { kind: "delete"; snapshot: GroupSnapshot }
  | { kind: "memory"; memoryId: number; memoryKind: "limitation" | "preference"; content: string }
  | { kind: "band"; colour: string; kg: number; previousKg: number | null; equipmentSlug: string }
  | {
      kind: "readiness";
      id: number;
      date: string;
      /** A chat word, or the /readiness button that was tapped. */
      signal: LogReadinessInput["signal"] | "tired" | "ok" | "strong";
    }
  | { kind: "bodyweight"; id: number; date: string; kg: number; previousKg: number | null }
  | {
      kind: "class";
      id: number;
      date: string;
      heavyGroups: string[];
      /** null = there was no row before. */
      previousGroups: string[] | null;
    }
  /** Only the items this write skipped; Undo restores each to its `before`. */
  | {
      kind: "skip";
      sessionDate: string;
      whole: boolean;
      items: { plannedItemId: number; planName: string; before: SessionItemBefore | null }[];
    };

// ---------------------------------------------------------------------------
// AI layer

export interface PromptCatalogEntry {
  slug: string;
  name: string;
  aliases: string[];
  type: ExerciseType;
  loadBasis: LoadBasis | null;
}

/** Static, cacheable part of the system prompt. */
export interface PromptStatic {
  catalog: PromptCatalogEntry[];
  hspuLadder: Candidate[];
}

export interface PromptContext {
  /** e.g. "Tue 27 Oct 2026 · Week 5 · Strength" or "Sun 18 Oct 2026 · rest day". */
  todayLabel: string;
  todayItems: { name: string; options: Candidate[]; prescription: string; status: string }[];
  aliases: { said: string; slug: string; name: string }[];
  /** Active limitations and preferences, newest first, capped by size (SPEC 5.6e). */
  memory: { kind: "limitation" | "preference"; content: string }[];
  pending: { summary: string; awaitingEdit: boolean } | null;
  /** Newest bot logs, formatted in code: edit_last_entry targets the first one. */
  lastSaved: { summary: string; sessionDate: string }[];
  recent: { role: "user" | "assistant"; text: string }[];
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Usage storage, injected into the AI loop (usage_logs in production). */
export interface UsageStore {
  totals(now: Date): Promise<{ day: number; month: number }>;
  record(usage: TokenUsage, now: Date): Promise<void>;
}

export interface ReadRecord {
  tool: string;
  /** The tool-result text sent to the model. */
  content: string;
  fallbackHtml: string | null;
}

export type IntentResult =
  | {
      kind: "ok";
      staged: StagedAction[];
      replyText: string | null;
      turns: number;
      /** Tool errors still unresolved at the end (a later call that fixed them doesn't count). */
      toolErrors: number;
      /** A model turn hit max_tokens: its tool calls were not executed. */
      truncated: boolean;
      /** Read-tool results as the model saw them, in call order. */
      reads: ReadRecord[];
    }
  | { kind: "budget_reached" };
