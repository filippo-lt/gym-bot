import { Bot, type Context, InlineKeyboard, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Db } from "../db/seed-plan.js";
import { trainingDate } from "../domain/calendar.js";
import { parseDayArg } from "../domain/day-ref.js";
import { loadSessionAdvice, type SessionAdvice } from "../progression/session-advice.js";
import { type ExerciseLookup, lookupExercise } from "../queries/exercise-lookup.js";
import { type ExerciseHistory, getExerciseHistory } from "../queries/history.js";
import { getPlanOverview, nextItem, type PlanOverview } from "../queries/plan-overview.js";
import { parseHistoryCallback } from "./callbacks.js";
import { formatSession, formatWeek, hiddenItemIds } from "./format.js";
import { createInputs } from "./inputs-flow.js";
import { HELP_TEXT, type Message, TEXT_ONLY, UNKNOWN_COMMAND } from "./log-format.js";
import { type AiSource, createFlow, type Flow, type MediaSource } from "./logging-flow.js";
import {
  formatHistory,
  formatHistoryChoice,
  formatNext,
  formatPlan,
  HISTORY_UNKNOWN,
  HISTORY_USAGE,
  SESSION_USAGE,
} from "./query-format.js";
import { getSession, getWeek, type Session, type WeekOverview } from "./session.js";

export interface BotDeps {
  db: Db;
  now: () => Date;
  token: string;
  botInfo?: UserFromGetMe;
  transformer?: Transformer;
  /** The AI model and token caps; a function is called only when free text arrives. */
  ai?: AiSource;
  /** Voice: STT provider and file download; commands and text work without it. */
  media?: MediaSource;
  /** Test seam: replace the DB queries. */
  sessions?: {
    getSession: (db: Db, date: string) => Promise<Session>;
    getWeek: (db: Db, date: string) => Promise<WeekOverview>;
  };
  /**
   * Test seam: the progression layer (suggested loads, readiness). By default it is real, except when `sessions` is
   * replaced: then there is no advice, so session tests need no progression tables.
   */
  advice?: (
    db: Db,
    date: string,
    now: Date,
    opts: { short?: boolean },
  ) => Promise<SessionAdvice | null>;
  /** Test seam: replace the read-only query DB calls (/history, /plan). */
  reads?: {
    lookupExercise: (db: Db, said: string) => Promise<ExerciseLookup>;
    getExerciseHistory: (db: Db, exerciseId: number) => Promise<ExerciseHistory | null>;
    getPlanOverview: (db: Db, today: string) => Promise<PlanOverview | null>;
  };
  /** Test seam: replace the logging flow. */
  flow?: Flow;
}

export { HELP_TEXT, TEXT_ONLY, UNKNOWN_COMMAND };

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  if (deps.transformer) bot.api.config.use(deps.transformer);
  const queries = deps.sessions ?? { getSession, getWeek };
  const flow =
    deps.flow ?? createFlow({ db: deps.db, now: deps.now, ai: deps.ai, media: deps.media });
  const reads = deps.reads ?? {
    lookupExercise,
    getExerciseHistory: (db: Db, id: number) => getExerciseHistory(db, id),
    getPlanOverview,
  };
  const html = { parse_mode: "HTML" as const };
  const today = () => trainingDate(deps.now());
  const adviceFor = deps.advice ?? (deps.sessions ? async () => null : loadSessionAdvice);

  /** The engine failing must never take the plain session away. */
  async function advise(date: string, short = false): Promise<SessionAdvice | null> {
    try {
      return await adviceFor(deps.db, date, deps.now(), { short });
    } catch (error) {
      console.error(
        `progression: advice failed (${error instanceof Error ? error.name : "error"})`,
      );
      return null;
    }
  }

  /** /today, /short, /session: the plan, then the adjusted loads; an HSPU advance card follows when due. */
  async function sendSession(ctx: Context, date: string, short = false): Promise<void> {
    const session = await queries.getSession(deps.db, date);
    const advice = session.kind === "session" ? await advise(date, short) : null;
    await ctx.reply(formatSession(session, advice, { short }), html);
    await inputs.hspuProposal(ctx, advice);
  }
  const inputs = createInputs({
    db: deps.db,
    now: deps.now,
    sendToday: (ctx) => sendSession(ctx, today()),
  });
  const withKeyboard = (m: Message) => {
    const kb = new InlineKeyboard();
    m.keyboard.forEach((row, i) => {
      for (const b of row) kb.text(b.text, b.data);
      if (i < m.keyboard.length - 1) kb.row();
    });
    return { ...html, reply_markup: kb };
  };

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP_TEXT, html));

  bot.command("today", (ctx) => sendSession(ctx, today()));
  bot.command("short", (ctx) => sendSession(ctx, today(), true));
  bot.command("readiness", (ctx) => inputs.readinessCommand(ctx));
  bot.command("bw", (ctx) => inputs.bodyweightCommand(ctx));
  bot.command("class", (ctx) => inputs.classCommand(ctx));

  bot.command("week", async (ctx) => {
    const week = await queries.getWeek(deps.db, trainingDate(deps.now()));
    await ctx.reply(formatWeek(week), html);
  });

  bot.command("next", async (ctx) => {
    const session = await queries.getSession(deps.db, today());
    const advice = session.kind === "session" ? await advise(today()) : null;
    const heavy =
      session.kind === "session" && session.thursday && session.thursday !== "not_reported"
        ? session.thursday.heavy
        : [];
    await ctx.reply(formatNext(nextItem(session, hiddenItemIds(advice)), advice, heavy), html);
  });

  bot.command("session", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) return void (await ctx.reply(SESSION_USAGE, html));
    const day = parseDayArg(arg, today());
    if (!day.ok) return void (await ctx.reply(`${day.error}\n${SESSION_USAGE}`, html));
    await sendSession(ctx, day.date);
  });

  bot.command("history", async (ctx) => {
    const said = ctx.match.trim();
    if (!said) return void (await ctx.reply(HISTORY_USAGE, html));
    const found = await reads.lookupExercise(deps.db, said);
    if (found.kind === "unknown") return void (await ctx.reply(HISTORY_UNKNOWN, html));
    if (found.kind === "ambiguous") {
      const choice = formatHistoryChoice(said, found.candidates);
      return void (await ctx.reply(choice.text, withKeyboard(choice)));
    }
    await sendHistory(ctx, found.exercise.id);
  });

  bot.command("plan", async (ctx) => {
    const overview = await reads.getPlanOverview(deps.db, today());
    await ctx.reply(overview ? formatPlan(overview) : "No plan found in the database.", html);
  });

  async function sendHistory(ctx: Context, exerciseId: number) {
    const history = await reads.getExerciseHistory(deps.db, exerciseId);
    await ctx.reply(history ? formatHistory(history) : HISTORY_UNKNOWN, html);
  }

  bot.command("undo", (ctx) => flow.undoCommand(ctx));
  bot.command("memory", (ctx) => flow.memoryCommand(ctx));
  bot.command("skip", (ctx) => flow.skipCommand(ctx));

  // /history buttons: before the generic handler, which would hand them to the logging flow.
  bot.callbackQuery(/^hx:\d{1,9}$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseHistoryCallback(ctx.callbackQuery.data);
    if (parsed) await sendHistory(ctx, parsed.exerciseId);
  });

  // /readiness, /class and the HSPU card: their own handlers, not the logging flow's.
  bot.callbackQuery(/^(rd|cg|pr):/, (ctx) => inputs.callback(ctx));
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
  bot.on("message:voice", (ctx) => flow.voice(ctx));
  bot.on("message", (ctx) => ctx.reply(TEXT_ONLY, html));

  return bot;
}
