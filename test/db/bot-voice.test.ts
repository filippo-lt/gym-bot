import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeModel,
  type ScriptedTurn,
  text,
  toolUse,
  turn,
} from "../../src/ai/fake-model.js";
import { createBot } from "../../src/bot/bot.js";
import {
  VOICE_BLANK,
  VOICE_BUDGET,
  VOICE_FAILED,
  VOICE_NOT_CONFIGURED,
  VOICE_TOO_LONG,
} from "../../src/bot/log-format.js";
import type { MediaSource } from "../../src/bot/logging-flow.js";
import { connect, MON, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "GymBot",
  username: "gymbot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const CHAT = 42;
const FROM = { id: CHAT, is_bot: false, first_name: "F" };
const CHAT_OBJ = { id: CHAT, type: "private" as const, first_name: "F" };

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

type Call = { method: string; payload: Record<string, unknown> };

function setup(
  script: ScriptedTurn[],
  opts: {
    transcript?: string | (() => Promise<string>);
    stt?: boolean;
    dailySecondsCap?: number;
  } = {},
) {
  const calls: Call[] = [];
  let mid = 1000;
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: ++mid,
          date: 0,
          chat: CHAT_OBJ,
          text: (payload as { text: string }).text,
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  };
  const model = createFakeModel(script);
  const transcribe = vi.fn(async () => {
    const t = opts.transcript ?? "";
    return typeof t === "function" ? t() : t;
  });
  const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const media: MediaSource = {
    stt:
      opts.stt === false
        ? () => {
            throw new Error("no key");
          }
        : () => ({
            stt: { name: "fake", transcribe },
            dailySecondsCap: opts.dailySecondsCap ?? 600,
          }),
    download,
  };
  const bot = createBot({
    db,
    now: () => MON,
    token: "123:abc",
    botInfo,
    transformer,
    ai: { model, dailyTokenCap: 1_000_000, monthlyTokenCap: 10_000_000 },
    media,
  });
  let uid = 2000;
  const voice = (duration = 5, updateId = ++uid) =>
    bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: CHAT_OBJ,
        from: FROM,
        voice: { file_id: "f1", file_unique_id: "u1", duration },
      },
    });
  const tap = (data: string, messageId: number, updateId = ++uid) =>
    bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        chat_instance: "x",
        from: FROM,
        message: { message_id: messageId, date: 0, chat: CHAT_OBJ },
        data,
      },
    });
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const texts = () => sent().map((c) => String(c.payload.text));
  const buttons = (c: Call | undefined): { text: string; data: string }[] =>
    (
      (c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data }));
  return { model, transcribe, download, voice, tap, sent, texts, buttons };
}

const tool = (name: string, input: unknown) => turn(toolUse(name, input));
const ok = turn(text("ok"));
const nothing = turn(text(""));
const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;

const facePulls = {
  exercise: { slug: "face_pull", said: "face pulls" },
  sets: { count: 1, reps: 15, load_kg: 20 },
  guessed_fields: [],
  needs_confirmation: false,
};

describe("voice notes", () => {
  it("a clear log goes to a confirm card with the heard line", async () => {
    const t = setup([tool("log_sets", facePulls), ok], { transcript: "15 face pulls at 20 kg" });
    await t.voice();
    expect(await count("log_groups")).toBe(0);
    const [p] = await sql`select input_source from pending_actions`;
    expect(p?.input_source).toBe("voice");
    const card = t.sent().at(-1);
    expect(String(card?.payload.text).startsWith("🎤 heard: 15 face pulls at 20 kg")).toBe(true);
    const okBtn = t.buttons(card).find((b) => /^pa:\d+:ok$/.test(b.data));
    await t.tap(okBtn?.data as string, 1001);
    const groups = await sql`select source from log_groups`;
    expect(groups.length).toBe(1);
    expect(groups[0]?.source).toBe("voice");
  });

  it("readiness by voice is a card, not a direct save", async () => {
    const t = setup([tool("log_readiness", { signal: "bad_sleep" }), nothing], {
      transcript: "I slept badly",
    });
    await t.voice();
    expect(await count("readiness_logs")).toBe(0);
    expect(await count("pending_actions")).toBe(1);
    expect(t.texts().at(-1)).toContain("🎤 heard: I slept badly");
  });

  it("a question is answered without a card, with the heard line", async () => {
    const t = setup([turn(text("Keep it easy today."))], { transcript: "what should I do today" });
    await t.voice();
    expect(await count("pending_actions")).toBe(0);
    expect(t.texts().at(-1)).toBe("🎤 heard: what should I do today\n\nKeep it easy today.");
  });

  it("a clarify card starts with the heard line", async () => {
    const said = {
      exercise: { said: "sq" },
      sets: { count: 3, reps: 8, load_kg: 60 },
      guessed_fields: [],
      needs_confirmation: false,
    };
    const t = setup([tool("log_sets", said), nothing], { transcript: "sq 3 by 8 at 60" });
    await t.voice();
    expect(t.texts().at(-1)?.startsWith("🎤 heard: sq 3 by 8 at 60")).toBe(true);
    expect(t.texts().at(-1)).toContain('Which exercise is "sq"?');
  });

  it("blank transcript: VOICE_BLANK and the model is never called", async () => {
    const t = setup([ok], { transcript: "." });
    await t.voice();
    expect(t.texts()).toEqual([VOICE_BLANK]);
    expect(t.model.requests.length).toBe(0);
  });

  it("retry after the card: STT once, one card", async () => {
    const t = setup([tool("log_sets", facePulls), ok], { transcript: "15 face pulls at 20 kg" });
    await t.voice(5, 3000);
    await t.voice(5, 3000);
    expect(t.transcribe).toHaveBeenCalledTimes(1);
    expect(t.sent().length).toBe(1);
  });

  it("not configured", async () => {
    const t = setup([ok], { stt: false });
    await t.voice();
    expect(t.texts()).toEqual([VOICE_NOT_CONFIGURED]);
  });

  it("too long: STT not called", async () => {
    const t = setup([ok], { transcript: "hello" });
    await t.voice(121);
    expect(t.texts()).toEqual([VOICE_TOO_LONG]);
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it("budget reached", async () => {
    const t = setup([ok], { transcript: "hello", dailySecondsCap: 10 });
    await t.voice(11);
    expect(t.texts()).toEqual([VOICE_BUDGET]);
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it("STT throws: VOICE_FAILED, no usage recorded; success records seconds", async () => {
    const bad = setup([ok], {
      transcript: async () => {
        throw new Error("boom");
      },
    });
    await bad.voice(7);
    expect(bad.texts()).toEqual([VOICE_FAILED]);
    expect(await count("usage_logs")).toBe(0);

    const good = setup([tool("log_sets", facePulls), ok], { transcript: "15 face pulls at 20 kg" });
    await good.voice(7);
    const rows = await sql`select stt_seconds from usage_logs where stt_seconds > 0`;
    expect(rows.map((r) => r.stt_seconds)).toEqual([7]);
  });
});
