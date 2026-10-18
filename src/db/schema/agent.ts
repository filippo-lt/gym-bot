import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { LedgerResult, StagedAction } from "../../logging/types.js";

export const PENDING_KINDS = ["confirm", "clarify_exercise", "delete"] as const;
export const PENDING_STATUSES = ["open", "executed", "cancelled", "replaced", "expired"] as const;
export const MEMORY_KINDS = ["alias", "preference", "limitation", "weekly_summary"] as const;

export const pendingKind = pgEnum("pending_kind", PENDING_KINDS);
export const pendingStatus = pgEnum("pending_status", PENDING_STATUSES);
export const memoryKind = pgEnum("memory_kind", MEMORY_KINDS);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const writeLedger = pgTable(
  "write_ledger",
  {
    sourceKey: text("source_key").notNull(),
    actionIndex: integer("action_index").notNull(),
    result: jsonb("result").$type<LedgerResult>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sourceKey, t.actionIndex] })],
).enableRLS();

export const pendingActions = pgTable(
  "pending_actions",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    kind: pendingKind("kind").notNull(),
    actions: jsonb("actions").$type<StagedAction[]>().notNull(),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    status: pendingStatus("status").notNull().default("open"),
    awaitingEdit: boolean("awaiting_edit").notNull().default(false),
    messageId: integer("message_id"),
    sourceUpdateId: bigint("source_update_id", { mode: "number" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("pending_actions_chat_status_idx").on(t.chatId, t.status)],
).enableRLS();

export const memoryItems = pgTable(
  "memory_items",
  {
    id: serial("id").primaryKey(),
    kind: memoryKind("kind").notNull(),
    content: text("content").notNull(),
    structured: jsonb("structured").$type<Record<string, unknown>>(),
    confirmed: boolean("confirmed").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    // One active alias per normalized alias text.
    uniqueIndex("memory_items_active_alias_unique")
      .on(sql`(${t.structured}->>'alias')`)
      .where(sql`${t.kind} = 'alias' AND ${t.active}`),
  ],
).enableRLS();

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("conversation_messages_role_valid", sql`${t.role} IN ('user', 'assistant')`),
    index("conversation_messages_chat_created_idx").on(t.chatId, t.createdAt),
  ],
).enableRLS();

export const usageLogs = pgTable(
  "usage_logs",
  {
    id: serial("id").primaryKey(),
    /** Europe/Rome calendar date of the call. */
    date: date("date", { mode: "string" }).notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    sttSeconds: integer("stt_seconds").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("usage_logs_date_idx").on(t.date)],
).enableRLS();
