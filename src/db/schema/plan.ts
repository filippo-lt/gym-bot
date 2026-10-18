import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { PlanChange } from "../../plan/types.js";
import type { FallbackPrescription, HiitSpec } from "../../plan-import/types.js";

export const EXERCISE_TYPES = [
  "weighted",
  "bodyweight_plus",
  "bodyweight_reps",
  "skill_ladder",
  "timed",
  "distance",
  "skill_practice",
  "hiit",
  "mobility",
  "warmup",
  "class",
  "recovery",
] as const;
export const LOAD_BASES = ["barbell_total", "per_hand", "stack", "bodyweight_plus"] as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

export const exerciseType = pgEnum("exercise_type", EXERCISE_TYPES);
export const loadBasis = pgEnum("load_basis", LOAD_BASES);
export const weekday = pgEnum("weekday", WEEKDAYS);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const plans = pgTable("plans", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  weeks: integer("weeks").notNull(),
  createdAt: createdAt(),
}).enableRLS();

export const planVersions = pgTable(
  "plan_versions",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id")
      .notNull()
      .references(() => plans.id),
    version: integer("version").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    weeks: integer("weeks").notNull(),
    change: jsonb("change").$type<PlanChange | null>(),
    sourceHash: text("source_hash").notNull(),
    resolvedHash: text("resolved_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("plan_versions_plan_id_version_unique").on(t.planId, t.version)],
).enableRLS();

export const planWeeks = pgTable(
  "plan_weeks",
  {
    planVersionId: integer("plan_version_id")
      .notNull()
      .references(() => planVersions.id),
    week: integer("week").notNull(),
    phase: text("phase").notNull(),
    isDeload: boolean("is_deload").notNull(),
    isTest: boolean("is_test").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.planVersionId, t.week] })],
).enableRLS();

export const equipment = pgTable("equipment", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  baseKg: numeric("base_kg", { precision: 6, scale: 2, mode: "number" }),
  stepKg: numeric("step_kg", { precision: 6, scale: 2, mode: "number" }),
  discreteValues: numeric("discrete_values", { precision: 6, scale: 2, mode: "number" }).array(),
  bands: jsonb("bands").$type<Record<string, number>>(),
}).enableRLS();

export const exercises = pgTable("exercises", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  muscleGroup: text("muscle_group").notNull(),
  type: exerciseType("type").notNull(),
  loadBasis: loadBasis("load_basis"),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  isMainLift: boolean("is_main_lift").notNull(),
}).enableRLS();

export const hspuLadder = pgTable("hspu_ladder", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  stepOrder: integer("step_order").notNull().unique(),
  defaultSets: integer("default_sets"),
  defaultRepsMin: integer("default_reps_min"),
  defaultRepsMax: integer("default_reps_max"),
  tempo: text("tempo"),
}).enableRLS();

export const plannedItems = pgTable(
  "planned_items",
  {
    id: serial("id").primaryKey(),
    planVersionId: integer("plan_version_id")
      .notNull()
      .references(() => planVersions.id),
    itemKey: text("item_key").notNull(),
    week: integer("week").notNull(),
    weekday: weekday("weekday").notNull(),
    itemOrder: integer("item_order").notNull(),
    subItem: integer("sub_item").notNull(),
    block: text("block").notNull(),
    planName: text("plan_name").notNull(),
    variantLabel: text("variant_label"),
    prescriptionRaw: text("prescription_raw").notNull(),
    extrasRaw: text("extras_raw"),
    setsMin: integer("sets_min"),
    setsMax: integer("sets_max"),
    repsMin: integer("reps_min"),
    repsMax: integer("reps_max"),
    perSide: boolean("per_side").notNull(),
    durationSMin: integer("duration_s_min"),
    durationSMax: integer("duration_s_max"),
    hiit: jsonb("hiit").$type<HiitSpec>(),
    tempo: text("tempo"),
    modifiers: text("modifiers").array().notNull().default(sql`'{}'::text[]`),
    hspuStepId: integer("hspu_step_id").references(() => hspuLadder.id),
    rirMin: numeric("rir_min", { precision: 3, scale: 1, mode: "number" }),
    rirMax: numeric("rir_max", { precision: 3, scale: 1, mode: "number" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    restRaw: text("rest_raw").notNull(),
    priority: text("priority").notNull(),
    note: text("note"),
    timeRaw: text("time_raw").notNull(),
    timeMinMin: integer("time_min_min"),
    timeMinMax: integer("time_min_max"),
    fallbackPrescription: jsonb("fallback_prescription").$type<FallbackPrescription>(),
  },
  (t) => [
    unique("planned_items_slot_unique").on(
      t.planVersionId,
      t.week,
      t.weekday,
      t.itemOrder,
      t.subItem,
    ),
    unique("planned_items_key_unique").on(t.planVersionId, t.itemKey),
  ],
).enableRLS();

export const plannedItemOptions = pgTable(
  "planned_item_options",
  {
    plannedItemId: integer("planned_item_id")
      .notNull()
      .references(() => plannedItems.id, { onDelete: "cascade" }),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercises.id),
    optionIndex: integer("option_index").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.plannedItemId, t.optionIndex] }),
    index("planned_item_options_exercise_id_idx").on(t.exerciseId),
  ],
).enableRLS();

export const sessionOverrides = pgTable(
  "session_overrides",
  {
    id: serial("id").primaryKey(),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    plannedItemId: integer("planned_item_id")
      .notNull()
      .references(() => plannedItems.id),
    replacedExerciseId: integer("replaced_exercise_id")
      .notNull()
      .references(() => exercises.id),
    replacementExerciseId: integer("replacement_exercise_id")
      .notNull()
      .references(() => exercises.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("session_overrides_slot_unique").on(
      t.sessionDate,
      t.plannedItemId,
      t.replacedExerciseId,
    ),
  ],
).enableRLS();
