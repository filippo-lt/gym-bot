import "./load-env.js";
import { Api } from "grammy";
import { botTokenEnv, webhookEnv } from "../src/config/env.js";

const base = process.argv[2];
if (!base) {
  console.error("Usage: pnpm telegram:setup <https base url>");
  process.exit(1);
}
let origin: URL;
try {
  origin = new URL(base);
} catch {
  console.error("Base URL is not a valid URL.");
  process.exit(1);
}
if (origin.protocol !== "https:") {
  console.error("Base URL must use https.");
  process.exit(1);
}

try {
  const api = new Api(botTokenEnv().TELEGRAM_BOT_TOKEN);
  const url = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/telegram`;

  await api.setWebhook(url, {
    secret_token: webhookEnv().TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  await api.setMyCommands([
    { command: "today", description: "Today's session" },
    { command: "next", description: "Next exercise" },
    { command: "skip", description: "Skip an exercise or the session" },
    { command: "session", description: "A session by day or date" },
    { command: "week", description: "This week" },
    { command: "short", description: "Today when short on time" },
    { command: "readiness", description: "How I feel today" },
    { command: "bw", description: "Log my bodyweight" },
    { command: "class", description: "Log Thursday's class" },
    { command: "plan", description: "Plan overview" },
    { command: "history", description: "Last sessions of an exercise" },
    { command: "chart", description: "Progress chart" },
    { command: "undo", description: "Remove my last log" },
    { command: "memory", description: "What I remember" },
    { command: "usage", description: "AI and voice usage" },
    { command: "export", description: "Backup of all data" },
    { command: "help", description: "Commands" },
  ]);

  const info = await api.getWebhookInfo();
  console.log(`webhook url: ${info.url}`);
  console.log(`pending_update_count: ${info.pending_update_count}`);
  console.log(`last_error_message: ${info.last_error_message ?? "(none)"}`);
} catch (error) {
  // Never print the cause, URL or token.
  const e = error as { description?: unknown; name?: unknown; issues?: unknown };
  const text =
    typeof e.description === "string"
      ? e.description
      : error instanceof Error && error.name === "EnvError"
        ? error.message
        : String(e.name ?? "error");
  console.error(`telegram:setup failed: ${text}`);
  process.exit(1);
}
