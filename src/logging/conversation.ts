import { and, desc, eq, gte, sql } from "drizzle-orm";
import { conversationMessages } from "../db/schema/agent.js";
import type { Q } from "./db.js";

export const RECENT_LIMIT = 10;
export const RECENT_WINDOW_MS = 6 * 3600 * 1000;
export const MESSAGE_MAX_CHARS = 500;
/** A retried inbox update re-sends the same user text within this window. */
export const DUPLICATE_USER_WINDOW_MINUTES = 10;

export async function appendMessage(
  db: Q,
  chatId: number,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  if (role === "user") {
    // A retried update must not repeat the user's message: skip when it is the latest row.
    // Keyed on text (rows carry no update id, and a migration is not worth it for this).
    const [last] = await db
      .select({
        role: conversationMessages.role,
        text: conversationMessages.text,
        recent: sql<boolean>`${conversationMessages.createdAt} > now() - make_interval(mins => ${DUPLICATE_USER_WINDOW_MINUTES})`,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.chatId, chatId))
      .orderBy(desc(conversationMessages.id))
      .limit(1);
    if (last && last.role === "user" && last.text === text && last.recent) return;
  }
  await db.insert(conversationMessages).values({ chatId, role, text });
}

/** Last 10 messages from the last 6 h, oldest first, long texts truncated. */
export async function recentMessages(
  db: Q,
  chatId: number,
  now: Date,
): Promise<{ role: "user" | "assistant"; text: string }[]> {
  const since = new Date(now.getTime() - RECENT_WINDOW_MS);
  const rows = await db
    .select({ role: conversationMessages.role, text: conversationMessages.text })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.chatId, chatId), gte(conversationMessages.createdAt, since)))
    .orderBy(desc(conversationMessages.id))
    .limit(RECENT_LIMIT);
  return rows.reverse().map((r) => ({
    role: r.role as "user" | "assistant",
    text: r.text.length > MESSAGE_MAX_CHARS ? `${r.text.slice(0, MESSAGE_MAX_CHARS)}…` : r.text,
  }));
}
