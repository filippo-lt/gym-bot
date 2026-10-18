import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { LEASE_S, MAX_ATTEMPTS } from "./constants.js";

export type InboxRow = {
  id: number;
  status: "pending" | "processing";
  payload: unknown;
  attempts: number;
};

export type NewInboxRow = { update_id: number; chat_id: number; payload: unknown };

/** Stores a raw update. Returns false when the update_id was already stored (dedupe). */
export async function enqueue(db: Db, row: NewInboxRow): Promise<boolean> {
  const rows = await db.execute(
    sql`INSERT INTO inbox (update_id, chat_id, payload)
        VALUES (${row.update_id}, ${row.chat_id}, ${JSON.stringify(row.payload)}::jsonb)
        ON CONFLICT (update_id) DO NOTHING
        RETURNING id`,
  );
  return rows.length > 0;
}

export type StuckRow = { id: number; payload: unknown; status: "pending" | "failed" };

/**
 * Rows claimed longer than the lease ago: back to pending, or failed when the attempts are used
 * up (a killed invocation must not bypass the cap).
 */
export async function resetStuck(db: Db, chatId: number): Promise<StuckRow[]> {
  return db.execute<StuckRow>(
    sql`UPDATE inbox
        SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed'::inbox_status
                          ELSE 'pending'::inbox_status END,
            error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'timed out' ELSE error END,
            done_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END
        WHERE chat_id = ${chatId} AND status = 'processing'
          AND claimed_at < now() - make_interval(secs => ${LEASE_S})
        RETURNING id::int AS id, payload, status`,
  );
}

/** Oldest row (Telegram update order) that is not done/failed. */
export async function oldestOpen(db: Db, chatId: number): Promise<InboxRow | null> {
  const rows = await db.execute<InboxRow>(
    sql`SELECT id::int AS id, status, payload, attempts FROM inbox
        WHERE chat_id = ${chatId} AND status IN ('pending', 'processing')
        ORDER BY update_id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Claims the row if it is still pending. Returns null when someone else got it. */
export async function claim(db: Db, id: number, owner: string): Promise<InboxRow | null> {
  const rows = await db.execute<InboxRow>(
    sql`UPDATE inbox
        SET status = 'processing', claimed_at = now(), claimed_by = ${owner}::uuid,
            attempts = attempts + 1
        WHERE id = ${id} AND status = 'pending' AND attempts < ${MAX_ATTEMPTS}
        RETURNING id::int AS id, status, payload, attempts`,
  );
  return rows[0] ?? null;
}

/**
 * Only the owner of a live claim can finish a row: when a stuck-row sweep already resolved it
 * (reset or failed) this changes nothing and returns false.
 */
export async function markDone(db: Db, id: number, owner: string): Promise<boolean> {
  const rows = await db.execute(
    sql`UPDATE inbox SET status = 'done', done_at = now(), error = NULL
        WHERE id = ${id} AND status = 'processing' AND claimed_by = ${owner}::uuid
        RETURNING id`,
  );
  return rows.length > 0;
}

/**
 * Back to pending, or failed once the attempts are used up. Null when the claim is no longer
 * ours (someone else already resolved the row): nothing changed, so nothing to report.
 */
export async function markRetryOrFailed(
  db: Db,
  id: number,
  owner: string,
  error: string,
): Promise<"pending" | "failed" | null> {
  const rows = await db.execute<{ status: "pending" | "failed" }>(
    sql`UPDATE inbox
        SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed'::inbox_status
                          ELSE 'pending'::inbox_status END,
            error = ${error.slice(0, 500)},
            done_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() ELSE NULL END
        WHERE id = ${id} AND status = 'processing' AND claimed_by = ${owner}::uuid
        RETURNING status`,
  );
  return rows[0]?.status ?? null;
}

/** Chats that have work a sweeper should pick up. */
export async function chatsWithOpenRows(db: Db): Promise<number[]> {
  const rows = await db.execute<{ chat_id: string }>(
    sql`SELECT DISTINCT chat_id::text AS chat_id FROM inbox
        WHERE status = 'pending'
           OR (status = 'processing' AND claimed_at < now() - make_interval(secs => ${LEASE_S}))`,
  );
  return rows.map((r) => Number(r.chat_id));
}
