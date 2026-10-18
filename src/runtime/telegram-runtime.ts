import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { telegramEnv } from "../config/env.js";
import { getDb } from "../db/client.js";
import type { ProcessChatDeps } from "./process-chat.js";

export const FAILED_MESSAGE =
  "Sorry — I couldn't process your last message after 3 tries. Please send it again.";

const INIT_TIMEOUT_MS = 10_000;

let botPromise: Promise<Bot> | undefined;

/** One bot per cold start; getMe (bot.init) runs once, lazily. */
export function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const { createBot } = await import("../bot/bot.js");
    const bot = createBot({
      db: getDb(),
      now: () => new Date(),
      token: telegramEnv().TELEGRAM_BOT_TOKEN,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        bot.init(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("bot.init timed out")), INIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return bot;
  })();
  botPromise.catch(() => {
    botPromise = undefined;
  });
  return botPromise;
}

/** The injected handlers that processChat needs, backed by the grammY bot. */
export async function botHandlers(): Promise<
  Pick<ProcessChatDeps, "handle" | "sendTyping" | "notifyFailed">
> {
  const bot = await getBot();
  return {
    handle: (payload) => bot.handleUpdate(payload as Update),
    sendTyping: async (chatId) => {
      await bot.api.sendChatAction(chatId, "typing");
    },
    notifyFailed: async (chatId) => {
      await bot.api.sendMessage(chatId, FAILED_MESSAGE);
    },
  };
}
