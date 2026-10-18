import "./load-env.js";
import Anthropic from "@anthropic-ai/sdk";
import { Api } from "grammy";
import postgres from "postgres";
import { aiEnv, cronEnv, dbEnv, telegramEnv, webhookEnv } from "../src/config/env.js";

type Check = { name: string; run: () => Promise<string | undefined> };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n").join(" | ").slice(0, 300);
  return "unknown error";
}

async function selectOne(url: string): Promise<string | undefined> {
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
  try {
    await sql`select 1`;
    return undefined;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const checks: Check[] = [
  { name: "env: db", run: async () => void dbEnv() },
  { name: "env: telegram", run: async () => void telegramEnv() },
  { name: "env: webhook", run: async () => void webhookEnv() },
  { name: "env: ai", run: async () => void aiEnv() },
  { name: "env: cron", run: async () => void cronEnv() },
  { name: "db: DATABASE_URL select 1", run: () => selectOne(dbEnv().DATABASE_URL) },
  {
    name: "db: MIGRATION_DATABASE_URL reachable",
    run: async () => {
      const url = dbEnv().MIGRATION_DATABASE_URL;
      if (!url) throw new Error("MIGRATION_DATABASE_URL is not set");
      return selectOne(url);
    },
  },
  {
    name: "telegram: getMe",
    run: async () => {
      const me = await new Api(telegramEnv().TELEGRAM_BOT_TOKEN).getMe();
      return `@${me.username}`;
    },
  },
  {
    name: "anthropic: minimal call",
    run: async () => {
      const env = aiEnv();
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      await client.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      });
      return env.ANTHROPIC_MODEL;
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    const detail = await check.run();
    console.log(`✅ ${check.name}${detail ? ` (${detail})` : ""}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${check.name}: ${describeError(error)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
