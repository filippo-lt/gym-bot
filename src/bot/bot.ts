import { Bot, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { formatSession, formatWeek } from "./format.js";
import { HELP_TEXT, TEXT_ONLY, UNKNOWN_COMMAND } from "./log-format.js";
import { type AiSource, createFlow, type Flow } from "./logging-flow.js";
import { getSession, getWeek, type Session, type WeekOverview } from "./session.js";

export interface BotDeps {
  db: Db;
  now: () => Date;
  token: string;
  botInfo?: UserFromGetMe;
  transformer?: Transformer;
  /** The AI model and token caps; a function is called only when free text arrives. */
  ai?: AiSource;
  /** Test seam: replace the DB queries. */
  sessions?: {
    getSession: (db: Db, date: string) => Promise<Session>;
    getWeek: (db: Db, date: string) => Promise<WeekOverview>;
  };
  /** Test seam: replace the logging flow. */
  flow?: Flow;
}

export { HELP_TEXT, TEXT_ONLY, UNKNOWN_COMMAND };

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  if (deps.transformer) bot.api.config.use(deps.transformer);
  const queries = deps.sessions ?? { getSession, getWeek };
  const flow = deps.flow ?? createFlow({ db: deps.db, now: deps.now, ai: deps.ai });
  const html = { parse_mode: "HTML" as const };

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP_TEXT, html));

  bot.command("today", async (ctx) => {
    const session = await queries.getSession(deps.db, trainingDate(deps.now()));
    await ctx.reply(formatSession(session), html);
  });

  bot.command("week", async (ctx) => {
    const week = await queries.getWeek(deps.db, trainingDate(deps.now()));
    await ctx.reply(formatWeek(week), html);
  });

  bot.command("undo", (ctx) => flow.undoCommand(ctx));
  bot.command("memory", (ctx) => flow.memoryCommand(ctx));

  bot.on("callback_query:data", (ctx) => flow.callback(ctx));
  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery());

  // Commands the bot does not know must not reach the model.
  bot.on("message:entities:bot_command", (ctx) => ctx.reply(UNKNOWN_COMMAND, html));
  // Garbled commands ("/week/help") carry no entity but still never reach the model.
  bot.on("message:text", (ctx) =>
    ctx.message.text.trimStart().startsWith("/")
      ? ctx.reply(UNKNOWN_COMMAND, html)
      : flow.text(ctx),
  );
  bot.on("message", (ctx) => ctx.reply(TEXT_ONLY, html));

  return bot;
}
