import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { createAnthropicModel } from "../ai/model.js";
import { inlineKeyboard, type Message } from "../bot/log-format.js";
import type { AiConfig, MediaSource } from "../bot/logging-flow.js";
import { aiEnv, telegramEnv } from "../config/env.js";
import { getDb } from "../db/client.js";
import { createStt } from "../stt/stt.js";
import { downloadTelegramFile } from "../telegram/files.js";
import type { ProcessChatDeps } from "./process-chat.js";

export const FAILED_MESSAGE =
  "Sorry — I couldn't process your last message after 3 tries. Please send it again.";

const INIT_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

let botPromise: Promise<Bot> | undefined;
let aiConfig: AiConfig | undefined;
let sttConfig: ReturnType<typeof createStt> | undefined;

/** Read lazily: commands keep working without the AI key. Throws when it is not configured. */
function lazyAi(): AiConfig {
  if (!aiConfig) {
    const env = aiEnv();
    aiConfig = {
      model: createAnthropicModel(),
      dailyTokenCap: env.AI_DAILY_TOKEN_CAP,
      monthlyTokenCap: env.AI_MONTHLY_TOKEN_CAP,
    };
  }
  return aiConfig;
}

/** Read lazily: text keeps working without an STT key. Throws when it is not configured. */
function lazyStt(): ReturnType<typeof createStt> {
  sttConfig ??= createStt();
  return sttConfig;
}

/** One bot per cold start; getMe (bot.init) runs once, lazily. */
export function getBot(): Promise<Bot> {
  botPromise ??= (async () => {
    const { createBot } = await import("../bot/bot.js");
    const token = telegramEnv().TELEGRAM_BOT_TOKEN;
    // `bot` is assigned before any update is handled, so the downloader can use its api.
    const media: MediaSource = {
      stt: lazyStt,
      download: (fileId, maxBytes) =>
        downloadTelegramFile({
          api: bot.api,
          token,
          fileId,
          maxBytes,
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        }),
    };
    const bot = createBot({ db: getDb(), now: () => new Date(), token, ai: lazyAi, media });
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

/** Send a message (with its inline keyboard) to the bot's single owner chat. */
export async function sendToOwner(m: Message): Promise<void> {
  const bot = await getBot();
  const opts = m.keyboard.length
    ? { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(m.keyboard) }
    : { parse_mode: "HTML" as const };
  await bot.api.sendMessage(telegramEnv().ALLOWED_TELEGRAM_USER_ID, m.text, opts);
}
