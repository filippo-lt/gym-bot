import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createBot, HELP_TEXT, TEXT_ONLY, UNKNOWN_COMMAND } from "../../src/bot/bot.js";
import { NO_AI_KEY } from "../../src/bot/log-format.js";
import type { Flow } from "../../src/bot/logging-flow.js";
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

function setup(flow?: Flow) {
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
    ...(flow ? { flow } : {}),
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
    ["hello there", NO_AI_KEY],
    ["/unknown", UNKNOWN_COMMAND],
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

  describe("routing to the logging flow", () => {
    function stubFlow() {
      const seen: string[] = [];
      const flow: Flow = {
        text: async (ctx) => void seen.push(`text:${ctx.message?.text}`),
        callback: async (ctx) => void seen.push(`cb:${ctx.callbackQuery?.data}`),
        undoCommand: async () => void seen.push("undo"),
        memoryCommand: async () => void seen.push("memory"),
      };
      return { seen, flow };
    }

    it("sends free text, callbacks and the new commands to the flow", async () => {
      const { seen, flow } = stubFlow();
      const { send, bot, calls } = setup(flow);
      await send("3x8 squat 60");
      await send("/undo");
      await send("/memory");
      await bot.handleUpdate({
        update_id: 500,
        callback_query: {
          id: "cb",
          chat_instance: "x",
          from: { id: 42, is_bot: false, first_name: "F" },
          data: "ug:7",
        },
      });
      expect(seen).toEqual(["text:3x8 squat 60", "undo", "memory", "cb:ug:7"]);
      expect(calls).toHaveLength(0);
    });

    it("does not send unknown commands to the flow", async () => {
      const { seen, flow } = stubFlow();
      const { send } = setup(flow);
      await send("/nope");
      expect(seen).toEqual([]);
    });

    it.each(["/week/help", "/today/memory", "/nope hello"])(
      "does not send garbled %s (no command entity) to the flow",
      async (body) => {
        const { seen, flow } = stubFlow();
        const { bot, calls } = setup(flow);
        await bot.handleUpdate({
          update_id: 700,
          message: {
            message_id: 1,
            date: 0,
            chat: { id: 42, type: "private", first_name: "F" },
            from: { id: 42, is_bot: false, first_name: "F" },
            text: body,
          },
        });
        expect(seen).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(String(calls[0]?.payload.text)).toBe("I don't know that command. Try /help.");
      },
    );

    it("answers non-text messages itself", async () => {
      const { seen, flow } = stubFlow();
      const { bot, calls } = setup(flow);
      await bot.handleUpdate({
        update_id: 600,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 42, type: "private", first_name: "F" },
          from: { id: 42, is_bot: false, first_name: "F" },
          voice: { file_id: "f", file_unique_id: "u", duration: 3 },
        },
      });
      expect(seen).toEqual([]);
      expect(String(calls[0]?.payload.text)).toBe(TEXT_ONLY);
    });
  });
});
