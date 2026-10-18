import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  type BotDeps,
  createBot,
  HELP_TEXT,
  TEXT_ONLY,
  UNKNOWN_COMMAND,
} from "../../src/bot/bot.js";
import { NO_AI_KEY } from "../../src/bot/log-format.js";
import type { Flow } from "../../src/bot/logging-flow.js";
import type { Db } from "../../src/db/seed-plan.js";
import type { CatalogExercise } from "../../src/logging/catalog.js";
import type { ExerciseHistory } from "../../src/queries/history.js";
import type { PlanOverview } from "../../src/queries/plan-overview.js";
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

function setup(flow?: Flow, reads?: BotDeps["reads"], charts?: BotDeps["charts"]) {
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
    ...(reads ? { reads } : {}),
    ...(charts ? { charts } : {}),
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

  it("/export replies first with the preparing message", async () => {
    // No database here: the export itself fails and logs; only the first reply matters.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, send } = setup();
    try {
      await send("/export");
      expect(errors).toHaveBeenCalled();
      expect(calls[0]?.method).toBe("sendMessage");
      expect(calls[0]?.payload.text).toBe("Preparing your backup…");
    } finally {
      errors.mockRestore();
    }
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
        voice: async () => void seen.push("voice"),
        photo: async () => void seen.push("photo"),
        callback: async (ctx) => void seen.push(`cb:${ctx.callbackQuery?.data}`),
        undoCommand: async () => void seen.push("undo"),
        memoryCommand: async () => void seen.push("memory"),
        usageCommand: async () => void seen.push("usage"),
        skipCommand: async () => void seen.push("skip"),
      };
      return { seen, flow };
    }

    it("sends free text, callbacks and the new commands to the flow", async () => {
      const { seen, flow } = stubFlow();
      const { send, bot, calls } = setup(flow);
      await send("3x8 squat 60");
      await send("/undo");
      await send("/memory");
      await send("/usage");
      await send("/skip");
      await bot.handleUpdate({
        update_id: 500,
        callback_query: {
          id: "cb",
          chat_instance: "x",
          from: { id: 42, is_bot: false, first_name: "F" },
          data: "ug:7",
        },
      });
      expect(seen).toEqual(["text:3x8 squat 60", "undo", "memory", "usage", "skip", "cb:ug:7"]);
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

    it("routes voice notes to the flow", async () => {
      const { seen, flow } = stubFlow();
      const { bot } = setup(flow);
      await bot.handleUpdate({
        update_id: 601,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 42, type: "private", first_name: "F" },
          from: { id: 42, is_bot: false, first_name: "F" },
          voice: { file_id: "f", file_unique_id: "u", duration: 3 },
        },
      });
      expect(seen).toEqual(["voice"]);
    });

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
          sticker: {
            file_id: "f",
            file_unique_id: "u",
            type: "regular",
            width: 1,
            height: 1,
            is_animated: false,
            is_video: false,
          },
        },
      });
      expect(seen).toEqual([]);
      expect(String(calls[0]?.payload.text)).toBe(TEXT_ONLY);
    });
  });
});

describe("query commands", () => {
  const squat = { id: 11, slug: "squat", name: "Squat" } as CatalogExercise;
  const history: ExerciseHistory = {
    exercise: {
      id: 11,
      slug: "squat",
      name: "Squat",
      type: "weighted",
      loadBasis: "barbell_total",
    },
    totalSessions: 1,
    sessions: [
      {
        sessionDate: "2026-10-20",
        weekday: "tue",
        week: 4,
        phase: "Deload",
        isDeload: true,
        isTest: false,
        source: "import",
        perSetUnknown: false,
        hspuStep: null,
        sets: [3, 2, 1].map((n) => ({
          setIndex: 4 - n,
          reps: 5,
          loadKg: 60,
          addedKg: null,
          assistKg: null,
          durationS: null,
          distanceM: null,
          padHeight: null,
          rir: null,
          rirPlus: false,
          clean: null,
        })),
      },
    ],
  };
  const overview: PlanOverview = {
    status: "active",
    startDate: "2026-09-28",
    week: 5,
    phase: "Strength",
    weekStart: "2026-10-26",
    weekEnd: "2026-11-01",
    phases: [{ fromWeek: 1, toWeek: 12, phase: "All" }],
    nextDeload: { week: 8, startDate: "2026-11-16" },
    nextTrainingDay: { date: "2026-10-26", weekday: "mon", focus: "Pull + hinge" },
  };

  function reads(lookup: Awaited<ReturnType<NonNullable<BotDeps["reads"]>["lookupExercise"]>>) {
    const seen: { history: number[]; lookups: string[]; plan: string[] } = {
      history: [],
      lookups: [],
      plan: [],
    };
    const r: NonNullable<BotDeps["reads"]> = {
      lookupExercise: async (_db, said) => {
        seen.lookups.push(said);
        return lookup;
      },
      getExerciseHistory: async (_db, id) => {
        seen.history.push(id);
        return history;
      },
      getPlanOverview: async (_db, today) => {
        seen.plan.push(today);
        return overview;
      },
    };
    return { r, seen };
  }
  const text = (c: { payload: Record<string, unknown> } | undefined) => String(c?.payload.text);

  it("/next shows the next item for today", async () => {
    const { calls, dates, send } = setup();
    await send("/next");
    expect(dates).toEqual(["2026-10-26"]);
    expect(calls).toHaveLength(1);
    expect(text(calls[0])).toContain("<b>Next up</b> · 1 of");
  });

  it.each([
    ["/session mon", "2026-10-26"],
    ["/session fri", "2026-10-30"],
    ["/session tomorrow", "2026-10-27"],
    ["/session yesterday", "2026-10-25"],
    ["/session 2026-11-02", "2026-11-02"],
    ["/session 3/11", "2026-11-03"],
  ])("%s asks for %s", async (command, date) => {
    const { calls, dates, send } = setup();
    await send(command);
    expect(dates).toEqual([date]);
    expect(calls).toHaveLength(1);
    expect(text(calls[0])).toContain("Week 5");
  });

  it("/session without or with a bad argument explains and reads nothing", async () => {
    const { calls, dates, send } = setup();
    await send("/session");
    await send("/session nonsense");
    expect(dates).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(text(calls[0])).toContain("/session mon");
    expect(text(calls[1])).toContain("nonsense");
  });

  it("/history <exercise> sends the history", async () => {
    const { r, seen } = reads({ kind: "ok", exercise: squat });
    const { calls, send } = setup(undefined, r);
    await send("/history hack squat");
    expect(seen.lookups).toEqual(["hack squat"]);
    expect(seen.history).toEqual([11]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(text(calls[0])).toContain("Tue 20 Oct · W4 deload — 3 × 5 · 60 kg · imported");
  });

  it("/history without argument gives usage; unknown exercise a short message", async () => {
    const none = reads({ kind: "unknown" });
    const { calls, send } = setup(undefined, none.r);
    await send("/history");
    await send("/history zzz");
    expect(none.seen.lookups).toEqual(["zzz"]);
    expect(text(calls[0])).toBe("Which exercise? For example: /history squat");
    expect(text(calls[1])).toBe("I don't know that exercise. Try /history squat.");
  });

  it("an ambiguous /history asks with hx buttons", async () => {
    const amb = reads({
      kind: "ambiguous",
      candidates: [
        { id: 11, slug: "squat", name: "Squat" },
        { id: 12, slug: "hack_squat", name: "Hack squat" },
      ],
    });
    const { calls, send } = setup(undefined, amb.r);
    await send("/history sq");
    expect(amb.seen.history).toEqual([]);
    expect(text(calls[0])).toBe('Which exercise is "sq"?');
    const markup = calls[0]?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(markup.inline_keyboard).toEqual([
      [{ text: "Squat", callback_data: "hx:11" }],
      [{ text: "Hack squat", callback_data: "hx:12" }],
    ]);
  });

  it("an hx tap answers the callback and sends the history, not the logging flow", async () => {
    const seenByFlow: string[] = [];
    const flow: Flow = {
      text: async () => {},
      voice: async () => {},
      photo: async () => {},
      callback: async (ctx) => void seenByFlow.push(String(ctx.callbackQuery?.data)),
      undoCommand: async () => {},
      memoryCommand: async () => {},
      usageCommand: async () => {},
      skipCommand: async () => {},
    };
    const h = reads({ kind: "unknown" });
    const { calls, bot } = setup(flow, h.r);
    await bot.handleUpdate({
      update_id: 800,
      callback_query: {
        id: "cb",
        chat_instance: "x",
        from: { id: 42, is_bot: false, first_name: "F" },
        data: "hx:12",
        message: {
          message_id: 5,
          date: 0,
          chat: { id: 42, type: "private", first_name: "F" },
        },
      },
    });
    expect(seenByFlow).toEqual([]);
    expect(h.seen.history).toEqual([12]);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(text(calls[1])).toContain("<b>Squat</b>");
  });

  it("/plan shows the overview for today", async () => {
    const h = reads({ kind: "unknown" });
    const { calls, send } = setup(undefined, h.r);
    await send("/plan");
    expect(h.seen.plan).toEqual(["2026-10-26"]);
    expect(text(calls[0])).toContain("<b>Week 5 · Strength</b> · 26 Oct – 1 Nov");
    expect(text(calls[0])).toContain("Next deload: week 8");
  });

  it("help lists the query commands", () => {
    for (const c of ["/next", "/session", "/history", "/plan"]) expect(HELP_TEXT).toContain(c);
  });
});

describe("/chart", () => {
  const squat = { id: 11, slug: "squat", name: "Squat" } as CatalogExercise;
  const lookups = (lookup: Awaited<ReturnType<NonNullable<BotDeps["reads"]>["lookupExercise"]>>) =>
    ({
      lookupExercise: async () => lookup,
      getExerciseHistory: async () => null,
      getPlanOverview: async () => null,
    }) satisfies NonNullable<BotDeps["reads"]>;
  function fakeCharts(ok = true) {
    const requests: unknown[] = [];
    const charts: NonNullable<BotDeps["charts"]> = {
      mainLifts: async () => [
        { id: 11, name: "Squat" },
        { id: 12, name: "Bench press" },
      ],
      buildChart: async (_db, req) => {
        requests.push(req);
        return ok
          ? { ok: true, png: Buffer.from("png"), caption: "<b>Squat</b> · 7 sessions", facts: {} }
          : { ok: false, reason: "not_enough_data", text: "Not enough data to chart Squat yet." };
      },
    };
    return { charts, requests };
  }
  const tap = (bot: ReturnType<typeof setup>["bot"], data: string) =>
    bot.handleUpdate({
      update_id: 900,
      callback_query: {
        id: "cb",
        chat_instance: "x",
        from: { id: 42, is_bot: false, first_name: "F" },
        data,
        message: { message_id: 5, date: 0, chat: { id: 42, type: "private", first_name: "F" } },
      },
    });
  type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

  it("without argument gives usage and main-lift buttons plus Volume", async () => {
    const { charts } = fakeCharts();
    const { calls, send } = setup(undefined, undefined, charts);
    await send("/chart");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(String(calls[0]?.payload.text)).toContain("/chart squat");
    const markup = calls[0]?.payload.reply_markup as Markup;
    expect(markup.inline_keyboard).toEqual([
      [{ text: "Squat", callback_data: "ch:11" }],
      [{ text: "Bench press", callback_data: "ch:12" }],
      [{ text: "Volume", callback_data: "ch:v" }],
    ]);
  });

  it("/chart volume sends a photo with the caption", async () => {
    const { charts, requests } = fakeCharts();
    const { calls, send } = setup(undefined, undefined, charts);
    await send("/chart volume");
    expect(requests).toEqual([{ kind: "volume" }]);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(calls[0]?.payload.caption).toBe("<b>Squat</b> · 7 sessions");
  });

  it("/chart <exercise> with one match builds the auto chart", async () => {
    const { charts, requests } = fakeCharts();
    const { calls, send } = setup(undefined, lookups({ kind: "ok", exercise: squat }), charts);
    await send("/chart squat");
    expect(requests).toEqual([{ kind: "exercise", exerciseId: 11, metric: "auto" }]);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]?.payload.caption).toBe("<b>Squat</b> · 7 sessions");
  });

  it("a chart that cannot be built replies with its text", async () => {
    const { charts } = fakeCharts(false);
    const { calls, send } = setup(undefined, lookups({ kind: "ok", exercise: squat }), charts);
    await send("/chart squat");
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(String(calls[0]?.payload.text)).toBe("Not enough data to chart Squat yet.");
  });

  it("unknown exercise gets a short message and no chart", async () => {
    const { charts, requests } = fakeCharts();
    const { calls, send } = setup(undefined, lookups({ kind: "unknown" }), charts);
    await send("/chart zzz");
    expect(requests).toEqual([]);
    expect(String(calls[0]?.payload.text)).toBe("I don't know that exercise. Try /chart squat.");
  });

  it("an ambiguous name asks with ch buttons", async () => {
    const { charts, requests } = fakeCharts();
    const amb = lookups({
      kind: "ambiguous",
      candidates: [
        { id: 11, slug: "squat", name: "Squat" },
        { id: 12, slug: "hack_squat", name: "Hack squat" },
      ],
    });
    const { calls, send } = setup(undefined, amb, charts);
    await send("/chart sq");
    expect(requests).toEqual([]);
    expect(String(calls[0]?.payload.text)).toBe('Which exercise is "sq"?');
    const markup = calls[0]?.payload.reply_markup as Markup;
    expect(markup.inline_keyboard).toEqual([
      [{ text: "Squat", callback_data: "ch:11" }],
      [{ text: "Hack squat", callback_data: "ch:12" }],
    ]);
  });

  it.each([
    ["ch:v", { kind: "volume" }],
    ["ch:12", { kind: "exercise", exerciseId: 12, metric: "auto" }],
  ])("a %s tap answers the callback and sends the photo", async (data, request) => {
    const { charts, requests } = fakeCharts();
    const { calls, bot } = setup(undefined, undefined, charts);
    await tap(bot, data);
    expect(requests).toEqual([request]);
    expect(calls.map((c) => c.method)).toEqual(["answerCallbackQuery", "sendPhoto"]);
  });

  it("a renderer failure replies with an apology and does not throw", async () => {
    const charts: NonNullable<BotDeps["charts"]> = {
      mainLifts: async () => [],
      buildChart: async () => {
        throw new Error("resvg missing");
      },
    };
    const { calls, send, bot } = setup(undefined, undefined, charts);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await send("/chart volume");
    await tap(bot, "ch:v");
    err.mockRestore();
    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "answerCallbackQuery",
      "sendMessage",
    ]);
    expect(String(calls[0]?.payload.text)).toBe("Sorry, I couldn't draw that chart right now.");
  });

  it("help lists /chart", () => {
    expect(HELP_TEXT).toContain("/chart");
  });
});
