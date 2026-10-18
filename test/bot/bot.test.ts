import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createBot, FALLBACK_TEXT, HELP_TEXT } from "../../src/bot/bot.js";
import type { Db } from "../../src/db/seed-plan.js";
import { sessionFor, weekFor } from "./helpers.js";

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

function setup() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const dates: string[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  };
  const bot = createBot({
    db: {} as Db,
    // Mon 26 Oct 2026, 06:00 Rome (CET)
    now: () => new Date("2026-10-26T05:00:00Z"),
    token: "123:abc",
    botInfo,
    transformer,
    sessions: {
      getSession: async (_db, date) => {
        dates.push(date);
        return sessionFor(5, "mon", date);
      },
      getWeek: async (_db, date) => {
        dates.push(date);
        return weekFor(5);
      },
    },
  });
  let id = 0;
  const send = (text: string) =>
    bot.handleUpdate({
      update_id: ++id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 42, type: "private", first_name: "F" },
        from: { id: 42, is_bot: false, first_name: "F" },
        text,
        entities: text.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }]
          : undefined,
      },
    });
  return { calls, dates, send, bot };
}

describe("createBot", () => {
  it.each([
    ["/today", "Week 5"],
    ["/week", "Week 5"],
    ["/help", HELP_TEXT],
    ["/start", HELP_TEXT],
    ["hello there", FALLBACK_TEXT],
    ["/unknown", FALLBACK_TEXT],
  ])("%s sends exactly one HTML message", async (text, expected) => {
    const { calls, send } = setup();
    await send(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(calls[0]?.payload.chat_id).toBe(42);
    expect(String(calls[0]?.payload.text)).toContain(expected);
  });

  it("uses the training date from now()", async () => {
    const { dates, send } = setup();
    await send("/today");
    await send("/week");
    expect(dates).toEqual(["2026-10-26", "2026-10-26"]);
  });

  it("answers callback queries without a message", async () => {
    const { calls, bot } = setup();
    await bot.handleUpdate({
      update_id: 99,
      callback_query: {
        id: "cb",
        chat_instance: "x",
        from: { id: 42, is_bot: false, first_name: "F" },
        data: "noop",
      },
    });
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery"]);
  });

  it("lets DB errors propagate", async () => {
    const failing = createBot({
      db: {} as Db,
      now: () => new Date(),
      token: "123:abc",
      botInfo,
      transformer: async () => ({ ok: true, result: true }) as never,
      sessions: {
        getSession: async () => {
          throw new Error("db down");
        },
        getWeek: async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(
      failing.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private", first_name: "F" },
          from: { id: 1, is_bot: false, first_name: "F" },
          text: "/today",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      }),
    ).rejects.toThrow();
  });
});
