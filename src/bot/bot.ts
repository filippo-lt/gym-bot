import { Bot, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { formatSession, formatWeek } from "./format.js";
import { getSession, getWeek, type Session, type WeekOverview } from "./session.js";

export interface BotDeps {
  db: Db;
  now: () => Date;
  token: string;
  botInfo?: UserFromGetMe;
  transformer?: Transformer;
  /** Test seam: replace the DB queries. */
  sessions?: {
    getSession: (db: Db, date: string) => Promise<Session>;
    getWeek: (db: Db, date: string) => Promise<WeekOverview>;
  };
}

export const HELP_TEXT =
  "I'm your workout bot.\nCommands:\n/today — today's session\n/week — this week\nLogging by chat and voice comes soon.";
export const FALLBACK_TEXT = "I can't read free text yet. Try /today or /week.";

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  if (deps.transformer) bot.api.config.use(deps.transformer);
  const queries = deps.sessions ?? { getSession, getWeek };
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

  bot.on("callback_query", (ctx) => ctx.answerCallbackQuery());

  bot.on("message", (ctx) => ctx.reply(FALLBACK_TEXT, html));

  return bot;
}
