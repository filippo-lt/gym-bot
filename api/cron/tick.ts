import { sql } from "drizzle-orm";
import { getDb } from "../../src/db/client.js";
import { requireCronAuth } from "../../src/http/auth.js";
import { JOBS } from "../../src/jobs/index.js";
import { runDueJobs } from "../../src/jobs/runner.js";
import { STOP_TAKING_AT_S } from "../../src/runtime/constants.js";
import { chatsWithOpenRows, purgeOldRows } from "../../src/runtime/inbox.js";
import { type ProcessSummary, processChat } from "../../src/runtime/process-chat.js";
import { botHandlers, sendFileToOwner, sendToOwner } from "../../src/runtime/telegram-runtime.js";

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

export async function GET(request: Request): Promise<Response> {
  const start = Date.now();
  try {
    const denied = requireCronAuth(request);
    if (denied) return denied;
  } catch {
    console.error("tick: invalid cron environment");
    return Response.json({ ok: false, error: "server misconfigured" }, { status: 500 });
  }

  try {
    const db = getDb();
    await db.execute(sql`select 1`);

    // Scheduled jobs must never block the sweeper.
    let jobs: Awaited<ReturnType<typeof runDueJobs>> = [];
    try {
      jobs = await runDueJobs(
        { db, now: new Date(), send: sendToOwner, sendFile: sendFileToOwner },
        JOBS,
      );
    } catch (error) {
      console.error("tick: jobs failed", error instanceof Error ? error.name : "");
    }

    // Retention: failures are logged by name only and never block the sweep.
    try {
      await purgeOldRows(db, new Date());
    } catch (error) {
      console.error("tick: inbox purge failed", error instanceof Error ? error.name : "");
    }

    const swept: ProcessSummary[] = [];
    const chats = await chatsWithOpenRows(db);
    if (chats.length > 0) {
      const handlers = await botHandlers();
      for (const chatId of chats) {
        swept.push(
          await processChat({
            db,
            chatId,
            ...handlers,
            deadline: start + STOP_TAKING_AT_S * 1000,
            startedAt: start,
          }),
        );
      }
    }
    return Response.json({ ok: true, swept, jobs });
  } catch (error) {
    console.error(
      "tick: failed, code:",
      errorCode(error),
      error instanceof Error ? error.name : "",
    );
    return Response.json({ ok: false }, { status: 503 });
  }
}
