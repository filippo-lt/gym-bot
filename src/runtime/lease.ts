import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { LEASE_S } from "./constants.js";

/** Takes or renews the chat lease. Returns false when another live owner holds it. */
export async function acquireOrRenew(db: Db, chatId: number, owner: string): Promise<boolean> {
  await db.execute(
    sql`INSERT INTO chat_lease (chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING`,
  );
  const rows = await db.execute(
    sql`UPDATE chat_lease
        SET owner = ${owner}::uuid, until = now() + make_interval(secs => ${LEASE_S})
        WHERE chat_id = ${chatId} AND (until < now() OR owner = ${owner}::uuid)
        RETURNING chat_id`,
  );
  return rows.length > 0;
}

/** Releases every lease held by `owner`. Returns the number of leases released. */
export async function release(db: Db, owner: string): Promise<number> {
  const rows = await db.execute(
    sql`UPDATE chat_lease SET until = now() WHERE owner = ${owner}::uuid RETURNING chat_id`,
  );
  return rows.length;
}
