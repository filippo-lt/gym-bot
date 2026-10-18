import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { exercises, hspuLadder, plannedItems } from "./plan.js";
import { suggestions } from "./progression.js";

export const SESSION_STATUSES = ["planned", "done", "modified", "skipped"] as const;
export const SESSION_ITEM_SOURCES = ["bot", "import"] as const;
export const READINESS_LEVELS = ["GREEN", "YELLOW", "RED"] as const;
export const LOG_SOURCES = ["text", "voice", "photo", "import"] as const;

export const sessionStatus = pgEnum("session_status", SESSION_STATUSES);
export const sessionItemSource = pgEnum("session_item_source", SESSION_ITEM_SOURCES);
export const readinessLevel = pgEnum("readiness_level", READINESS_LEVELS);
export const dataSource = pgEnum("data_source", ["import", "bot"]);
export const logSource = pgEnum("log_source", LOG_SOURCES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const sessionItems = pgTable(
  "session_items",
  {
    id: serial("id").primaryKey(),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    plannedItemId: integer("planned_item_id")
      .notNull()
      .references(() => plannedItems.id),
    status: sessionStatus("status").notNull(),
    chosenExerciseId: integer("chosen_exercise_id").references(() => exercises.id),
    note: text("note"),
    source: sessionItemSource("source").notNull(),
    importRowKey: text("import_row_key").unique(),
    createdAt: createdAt(),
  },
  (t) => [unique("session_items_date_item_unique").on(t.sessionDate, t.plannedItemId)],
).enableRLS();

export const logGroups = pgTable("log_groups", {
  id: serial("id").primaryKey(),
  sessionDate: date("session_date", { mode: "string" }).notNull(),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
  plannedItemId: integer("planned_item_id").references(() => plannedItems.id),
  subItem: integer("sub_item").notNull().default(0),
  exerciseId: integer("exercise_id")
    .notNull()
    .references(() => exercises.id),
  /** The stored suggestion shown for this item/option when logged (SPEC 5.6c drift, 5.6d far-off check). */
  suggestionId: integer("suggestion_id").references(() => suggestions.id, { onDelete: "set null" }),
  bwKg: numeric("bw_kg", { precision: 5, scale: 2, mode: "number" }),
  readinessLevel: readinessLevel("readiness_level"),
  source: logSource("source").notNull(),
  importRowKey: text("import_row_key").unique(),
  perSetUnknown: boolean("per_set_unknown").notNull().default(false),
  note: text("note"),
  /** HSPU ladder step: user state taken from the last log (SPEC 5.2). */
  hspuStepId: integer("hspu_step_id").references(() => hspuLadder.id),
  createdAt: createdAt(),
}).enableRLS();

export const logEntries = pgTable(
  "log_entries",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .notNull()
      .references(() => logGroups.id, { onDelete: "cascade" }),
    setIndex: integer("set_index").notNull(),
    reps: integer("reps"),
    loadKg: numeric("load_kg", { precision: 6, scale: 2, mode: "number" }),
    addedKg: numeric("added_kg", { precision: 6, scale: 2, mode: "number" }),
    assistKg: numeric("assist_kg", { precision: 6, scale: 2, mode: "number" }),
    /** Band colour when assistance came from a band; kg comes from equipment.bands (SPEC 5.2). */
    band: text("band"),
    durationS: integer("duration_s"),
    distanceM: numeric("distance_m", { mode: "number" }),
    padHeight: numeric("pad_height", { precision: 5, scale: 1, mode: "number" }),
    rir: numeric("rir", { precision: 3, scale: 1, mode: "number" }),
    rirPlus: boolean("rir_plus").notNull().default(false),
    clean: boolean("clean"),
    note: text("note"),
  },
  (t) => [unique("log_entries_group_set_unique").on(t.groupId, t.setIndex)],
).enableRLS();

export const classLogs = pgTable(
  "class_logs",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull().unique(),
    rawText: text("raw_text"),
    photoFileId: text("photo_file_id"),
    parsed: jsonb("parsed"),
    heavyGroups: text("heavy_groups").array().notNull().default(sql`'{}'::text[]`),
    source: dataSource("source").notNull(),
  },
  (t) => [
    check(
      "class_logs_heavy_groups_valid",
      sql`${t.heavyGroups} <@ ARRAY['pull','push','legs']::text[]`,
    ),
  ],
).enableRLS();

export const weeklyMetrics = pgTable(
  "weekly_metrics",
  {
    id: serial("id").primaryKey(),
    planWeek: integer("plan_week").notNull(),
    metric: text("metric").notNull(),
    valueNum: numeric("value_num", { mode: "number" }),
    valueText: text("value_text"),
    unit: text("unit"),
    source: dataSource("source").notNull(),
    importRowKey: text("import_row_key").unique(),
  },
  (t) => [unique("weekly_metrics_week_metric_unique").on(t.planWeek, t.metric)],
).enableRLS();

export const bodyweightLogs = pgTable("bodyweight_logs", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull().unique(),
  kg: numeric("kg", { precision: 5, scale: 2, mode: "number" }).notNull(),
  source: dataSource("source").notNull(),
}).enableRLS();
