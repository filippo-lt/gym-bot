import { and, desc, eq, lte } from "drizzle-orm";
import { pendingActions } from "../db/schema/agent.js";
import type { Db, Q } from "./db.js";
import type { StagedAction } from "./types.js";

export type Pending = typeof pendingActions.$inferSelect;
export type PendingKind = Pending["kind"];

export const PENDING_TTL_MS = 30 * 60 * 1000;

export async function createPending(
  db: Db,
  args: {
    chatId: number;
    kind: PendingKind;
    actions: StagedAction[];
    reasons: string[];
    sourceUpdateId: number | null;
    now: Date;
  },
): Promise<{ pending: Pending; replaced: Pending | null; reused: boolean }> {
  return db.transaction(async (tx) => {
    // The handler can run twice for one update: the second run reuses the first run's request.
    if (args.sourceUpdateId !== null) {
      const existing = await getPendingBySourceUpdate(tx, args.chatId, args.sourceUpdateId);
      if (existing) return { pending: existing, replaced: null, reused: true };
    }
    const older = await tx
      .update(pendingActions)
      .set({ status: "replaced" })
      .where(and(eq(pendingActions.chatId, args.chatId), eq(pendingActions.status, "open")))
      .returning();
    const [pending] = await tx
      .insert(pendingActions)
      .values({
        chatId: args.chatId,
        kind: args.kind,
        actions: args.actions,
        reasons: args.reasons,
        sourceUpdateId: args.sourceUpdateId,
        createdAt: args.now,
        expiresAt: new Date(args.now.getTime() + PENDING_TTL_MS),
      })
      .returning();
    // An already-expired older request is not worth announcing as cancelled.
    const replaced =
      older
        .filter((p) => p.expiresAt.getTime() > args.now.getTime())
        .sort((a, b) => b.id - a.id)[0] ?? null;
    return { pending: pending as Pending, replaced, reused: false };
  });
}

export async function getPendingBySourceUpdate(
  db: Q,
  chatId: number,
  updateId: number,
): Promise<Pending | null> {
  const [row] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.chatId, chatId), eq(pendingActions.sourceUpdateId, updateId)))
    .orderBy(desc(pendingActions.id))
    .limit(1);
  return row ?? null;
}

export async function getPending(db: Q, id: number): Promise<Pending | null> {
  const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id));
  return row ?? null;
}

/** The chat's open pending action; an expired one is marked expired and treated as none. */
export async function getOpenPending(db: Q, chatId: number, now: Date): Promise<Pending | null> {
  await db
    .update(pendingActions)
    .set({ status: "expired" })
    .where(
      and(
        eq(pendingActions.chatId, chatId),
        eq(pendingActions.status, "open"),
        lte(pendingActions.expiresAt, now),
      ),
    );
  const [row] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.chatId, chatId), eq(pendingActions.status, "open")))
    .orderBy(desc(pendingActions.id))
    .limit(1);
  return row ?? null;
}

export async function setPendingMessageId(db: Q, id: number, messageId: number): Promise<void> {
  await db.update(pendingActions).set({ messageId }).where(eq(pendingActions.id, id));
}

export async function markAwaitingEdit(db: Q, id: number): Promise<boolean> {
  const rows = await db
    .update(pendingActions)
    .set({ awaitingEdit: true })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "open")))
    .returning({ id: pendingActions.id });
  return rows.length > 0;
}

/** True when it was open and is now cancelled. */
export async function cancelPending(db: Q, id: number): Promise<boolean> {
  const rows = await db
    .update(pendingActions)
    .set({ status: "cancelled" })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "open")))
    .returning({ id: pendingActions.id });
  return rows.length > 0;
}

/** After a clarify answer: swap in the resolved actions (and usually kind/reasons). */
export async function replacePendingActions(
  db: Q,
  id: number,
  actions: StagedAction[],
  patch: { kind?: PendingKind; reasons?: string[] } = {},
): Promise<Pending | null> {
  const [row] = await db
    .update(pendingActions)
    .set({ actions, awaitingEdit: false, ...patch })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "open")))
    .returning();
  return row ?? null;
}
