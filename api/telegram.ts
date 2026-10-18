import { waitUntil } from "@vercel/functions";
import { telegramEnv, webhookEnv } from "../src/config/env.js";
import { getDb } from "../src/db/client.js";
import { hasValidSecretHeader } from "../src/http/auth.js";
import { STOP_TAKING_AT_S } from "../src/runtime/constants.js";
import { enqueue } from "../src/runtime/inbox.js";
import { processChat } from "../src/runtime/process-chat.js";
import { botHandlers } from "../src/runtime/telegram-runtime.js";
import { chatId, minimalUpdateSchema, senderId } from "../src/telegram/update.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const ok = () => Response.json({ ok: true });

export async function POST(request: Request): Promise<Response> {
  const start = Date.now();
  try {
    let allowedUserId: number;
    let secret: string;
    try {
      secret = webhookEnv().TELEGRAM_WEBHOOK_SECRET;
      allowedUserId = telegramEnv().ALLOWED_TELEGRAM_USER_ID;
    } catch {
      console.error("telegram: invalid environment");
      return Response.json({ ok: false, error: "server misconfigured" }, { status: 500 });
    }

    if (!hasValidSecretHeader(request, SECRET_HEADER, secret)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      console.error("telegram: body is not JSON, ignored");
      return ok();
    }
    const parsed = minimalUpdateSchema.safeParse(body);
    if (!parsed.success) {
      console.error("telegram: unrecognised update shape, ignored");
      return ok();
    }
    const update = parsed.data;
    const chat = chatId(update);
    if (senderId(update) !== allowedUserId || chat === undefined) return ok();

    const db = getDb();
    const inserted = await enqueue(db, {
      update_id: update.update_id,
      chat_id: chat,
      payload: body,
    });
    console.log(`telegram: update ${update.update_id} ${inserted ? "stored" : "duplicate"}`);

    waitUntil(
      (async () => {
        try {
          const handlers = await botHandlers();
          const summary = await processChat({
            db,
            chatId: chat,
            ...handlers,
            deadline: start + STOP_TAKING_AT_S * 1000,
            startedAt: start,
          });
          console.log(
            `telegram: chat processed=${summary.processed} failed=${summary.failed} stop=${summary.stoppedReason}`,
          );
        } catch (error) {
          console.error(
            "telegram: processing failed:",
            error instanceof Error ? error.name : "unknown",
          );
        }
      })(),
    );
    return ok();
  } catch (error) {
    console.error("telegram: unexpected error:", error instanceof Error ? error.name : "unknown");
    return Response.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
