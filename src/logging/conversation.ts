import { and, desc, eq, gte } from "drizzle-orm";
import { conversationMessages } from "../db/schema/agent.js";
import type { Q } from "./db.js";

export const RECENT_LIMIT = 10;
export const RECENT_WINDOW_MS = 6 * 3600 * 1000;
export const MESSAGE_MAX_CHARS = 500;

export async function appendMessage(
  db: Q,
  chatId: number,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
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
