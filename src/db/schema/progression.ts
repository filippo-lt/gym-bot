import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
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

export const READINESS_LOG_KINDS = [
  "button_tired",
  "button_ok",
  "button_strong",
  "chat_bad_sleep",
  "chat_sore",
  "chat_exhausted",
  "recovery_low",
  "drift",
] as const;
export const READINESS_LOG_SOURCES = ["button", "chat", "derived"] as const;
export const PROPOSAL_KINDS = ["hspu_advance", "earlier_deload"] as const;
export const PROPOSAL_STATUSES = ["open", "accepted", "declined", "expired"] as const;

export const readinessLogSource = pgEnum("readiness_log_source", READINESS_LOG_SOURCES);
export const proposalKind = pgEnum("proposal_kind", PROPOSAL_KINDS);
export const proposalStatus = pgEnum("proposal_status", PROPOSAL_STATUSES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Stored suggestion per (date, item, option) — SPEC 5.2 / 6. Frozen once a log group uses it.
 * readiness_level is text + check (not the readiness_level enum) to avoid a schema import cycle with log.ts.
 */
export const suggestions = pgTable(
  "suggestions",
  {
    id: serial("id").primaryKey(),
    sessionDate: date("session_date", { mode: "string" }).notNull(),
    plannedItemId: integer("planned_item_id")
      .notNull()
      .references(() => plannedItems.id),
    subItem: integer("sub_item").notNull().default(0),
    exerciseId: integer("exercise_id")
      .notNull()
      .references(() => exercises.id),
    sets: integer("sets").notNull(),
    repsMin: integer("reps_min").notNull(),
    repsMax: integer("reps_max").notNull(),
    rirMin: numeric("rir_min", { precision: 3, scale: 1, mode: "number" }).notNull(),
    rirMax: numeric("rir_max", { precision: 3, scale: 1, mode: "number" }).notNull(),
    rirMid: numeric("rir_mid", { precision: 3, scale: 1, mode: "number" }).notNull(),
    loadKg: numeric("load_kg", { precision: 6, scale: 2, mode: "number" }),
    addedKg: numeric("added_kg", { precision: 6, scale: 2, mode: "number" }),
    assistKg: numeric("assist_kg", { precision: 6, scale: 2, mode: "number" }),
    band: text("band"),
    systemLoad: numeric("system_load", { precision: 6, scale: 2, mode: "number" }),
    e1rmUsed: numeric("e1rm_used", { precision: 6, scale: 2, mode: "number" }),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    readinessLevel: text("readiness_level"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("suggestions_slot_unique").on(t.sessionDate, t.plannedItemId, t.subItem, t.exerciseId),
    check(
      "suggestions_readiness_valid",
      sql`${t.readinessLevel} IS NULL OR ${t.readinessLevel} IN ('GREEN', 'YELLOW', 'RED')`,
    ),
  ],
).enableRLS();

/** One row per readiness signal (SPEC 5.6c). `level` only for derived rows. */
export const readinessLogs = pgTable(
  "readiness_logs",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    source: readinessLogSource("source").notNull(),
    level: text("level"),
    /** Exercise id for `drift` rows. */
    exerciseId: integer("exercise_id").references(() => exercises.id),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("readiness_logs_date_idx").on(t.date),
    check(
      "readiness_logs_kind_valid",
      sql`${t.kind} IN ('button_tired', 'button_ok', 'button_strong', 'chat_bad_sleep', 'chat_sore', 'chat_exhausted', 'recovery_low', 'drift')`,
    ),
    check(
      "readiness_logs_level_valid",
      sql`${t.level} IS NULL OR ${t.level} IN ('GREEN', 'YELLOW', 'RED')`,
    ),
  ],
).enableRLS();

/** Cache only: always derivable from history (SPEC 5.2). Single row, id = 1. */
export const userState = pgTable(
  "user_state",
  {
    id: integer("id").primaryKey().default(1),
    pullupGateOpen: boolean("pullup_gate_open").notNull().default(false),
    pullupGateSince: date("pullup_gate_since", { mode: "string" }),
    lastBwMax: integer("last_bw_max"),
    hspuStepId: integer("hspu_step_id").references(() => hspuLadder.id),
    hspuPadHeight: numeric("hspu_pad_height", { precision: 5, scale: 1, mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("user_state_single_row", sql`${t.id} = 1`)],
).enableRLS();

/** Bot proposals that need the user's decision (SPEC 5.6c / 5.2 HSPU). */
export const proposals = pgTable(
  "proposals",
  {
    id: serial("id").primaryKey(),
    kind: proposalKind("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: proposalStatus("status").notNull().default("open"),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    messageId: integer("message_id"),
  },
  (t) => [index("proposals_kind_status_idx").on(t.kind, t.status)],
).enableRLS();
