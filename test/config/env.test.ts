import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const original = { ...process.env };

async function load() {
  vi.resetModules();
  return import("../../src/config/env.js");
}

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE|MIGRATION|TELEGRAM|ALLOWED|CRON|ANTHROPIC|AI_|STT|GROQ|OPENAI)/.test(key)) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.env = { ...original };
});

describe("env", () => {
  it("lists missing variables in a readable error", async () => {
    const { telegramEnv } = await load();
    expect(() => telegramEnv()).toThrowError(/TELEGRAM_BOT_TOKEN: missing/);
    expect(() => telegramEnv()).toThrowError(/ALLOWED_TELEGRAM_USER_ID/);
  });

  it("applies AI defaults", async () => {
    process.env.ANTHROPIC_API_KEY = "key";
    const { aiEnv } = await load();
    const env = aiEnv();
    expect(env.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    expect(env.AI_DAILY_TOKEN_CAP).toBeGreaterThan(0);
    expect(env.AI_MONTHLY_TOKEN_CAP).toBeGreaterThan(env.AI_DAILY_TOKEN_CAP);
  });

  it("treats empty optional values as unset", async () => {
    process.env.ANTHROPIC_API_KEY = "key";
    process.env.ANTHROPIC_MODEL = "";
    const { aiEnv } = await load();
    expect(aiEnv().ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
  });

  it("coerces the Telegram user id to a number", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s";
    process.env.ALLOWED_TELEGRAM_USER_ID = "12345";
    const { telegramEnv } = await load();
    expect(telegramEnv().ALLOWED_TELEGRAM_USER_ID).toBe(12345);
  });

  it("rejects a CRON_SECRET that is too short", async () => {
    process.env.CRON_SECRET = "short";
    const { cronEnv } = await load();
    expect(() => cronEnv()).toThrowError(/at least 32/);
  });

  it("requires the key of the chosen STT provider", async () => {
    process.env.STT_PROVIDER = "groq";
    process.env.OPENAI_API_KEY = "x";
    const { sttEnv } = await load();
    expect(() => sttEnv()).toThrowError(/GROQ_API_KEY/);
  });

  it("requires DATABASE_URL", async () => {
    const { dbEnv } = await load();
    expect(() => dbEnv()).toThrowError(/DATABASE_URL: missing/);
  });

  it("uses the exact cap defaults", async () => {
    process.env.ANTHROPIC_API_KEY = "key";
    const { aiEnv } = await load();
    expect(aiEnv().AI_DAILY_TOKEN_CAP).toBe(200_000);
    expect(aiEnv().AI_MONTHLY_TOKEN_CAP).toBe(3_000_000);
  });

  it("parses explicit caps and rejects loose numbers", async () => {
    process.env.ANTHROPIC_API_KEY = "key";
    process.env.AI_DAILY_TOKEN_CAP = "500";
    let mod = await load();
    expect(mod.aiEnv().AI_DAILY_TOKEN_CAP).toBe(500);
    for (const bad of ["1e3", "0x10", "12.5", " 5", "-1", "0"]) {
      process.env.AI_DAILY_TOKEN_CAP = bad;
      mod = await load();
      expect(() => mod.aiEnv(), bad).toThrowError(/AI_DAILY_TOKEN_CAP/);
    }
  });

  it("rejects invalid Telegram user ids", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s";
    for (const bad of ["0x1A", "1e3", "12.0", " 12", "0", "-5", "abc"]) {
      process.env.ALLOWED_TELEGRAM_USER_ID = bad;
      const { telegramEnv } = await load();
      expect(() => telegramEnv(), bad).toThrowError(/ALLOWED_TELEGRAM_USER_ID/);
    }
  });

  it("parses dbEnv", async () => {
    process.env.DATABASE_URL = "postgres://x";
    const { dbEnv } = await load();
    expect(dbEnv()).toEqual({ DATABASE_URL: "postgres://x", MIGRATION_DATABASE_URL: undefined });
  });

  it("parses sttEnv and reports a missing provider as missing", async () => {
    process.env.STT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "k";
    let mod = await load();
    expect(mod.sttEnv().STT_PROVIDER).toBe("openai");
    delete process.env.STT_PROVIDER;
    mod = await load();
    expect(() => mod.sttEnv()).toThrowError(/STT_PROVIDER: missing/);
    process.env.STT_PROVIDER = "azure";
    mod = await load();
    expect(() => mod.sttEnv()).toThrowError(/must be groq or openai/);
  });
});
