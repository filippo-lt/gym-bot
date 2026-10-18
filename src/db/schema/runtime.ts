import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const INBOX_STATUSES = ["pending", "processing", "done", "failed"] as const;
export const inboxStatus = pgEnum("inbox_status", INBOX_STATUSES);

export const inbox = pgTable(
  "inbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    updateId: bigint("update_id", { mode: "number" }).notNull().unique(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    status: inboxStatus("status").notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: uuid("claimed_by"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [
    index("inbox_chat_status_update_idx").on(t.chatId, t.status, t.updateId),
    // Serves oldestOpen and chatsWithOpenRows.
    // TODO(M9): retention - purge done rows after N days.
    index("inbox_open_idx")
      .on(t.chatId, t.updateId)
      .where(sql`${t.status} IN ('pending', 'processing')`),
  ],
).enableRLS();

export const chatLease = pgTable("chat_lease", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  owner: uuid("owner"),
  until: timestamp("until", { withTimezone: true }).notNull().default(new Date(0)),
}).enableRLS();
