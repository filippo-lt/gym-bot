import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeModel,
  type ScriptedTurn,
  text,
  toolUse,
  turn,
} from "../../src/ai/fake-model.js";
import { createBot } from "../../src/bot/bot.js";
import { EXPIRED } from "../../src/bot/log-format.js";
import { executeActions } from "../../src/logging/execute.js";
import { stageLogSets } from "../../src/logging/resolve.js";
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

type Call = { method: string; payload: Record<string, unknown> };

let clock = MON;
beforeEach(async () => {
  clock = MON;
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

function setup(script: ScriptedTurn[] = [], caps = { daily: 1_000_000, monthly: 10_000_000 }) {
  const calls: Call[] = [];
  let mid = 1000;
  const fail = { edits: false };
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (fail.edits && method === "editMessageText") throw new Error("message can't be edited");
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
  const bot = createBot({
    db,
    now: () => clock,
    token: "123:abc",
    botInfo,
    transformer,
    ai: { model, dailyTokenCap: caps.daily, monthlyTokenCap: caps.monthly },
  });
  let uid = 1000;
  const say = (body: string, updateId = ++uid) =>
    bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: CHAT_OBJ,
        from: FROM,
        text: body,
        entities: body.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: body.split(" ")[0]?.length ?? 0 }]
          : undefined,
      },
    });
  const tap = (data: string, messageId = 1, updateId = ++uid) =>
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
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery");
  const texts = () => sent().map((c) => String(c.payload.text));
  const buttons = (c: Call | undefined): { text: string; data: string }[] =>
    (
      (c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data }));
  const lastSent = () => sent().at(-1);
  return { calls, fail, model, say, tap, sent, edits, answers, texts, buttons, lastSent };
}

const tool = (name: string, input: unknown) => turn(toolUse(name, input));
const ok = turn(text("ok"));

const swapInput = (over: Record<string, unknown> = {}) => ({
  exercise: { said: "hack squat", slug: "hack_squat" },
  replacement: { said: "cable row", slug: "cable_row" },
  ...over,
});

const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;
const pendingId = async () =>
  ((await sql`select id from pending_actions order by id desc limit 1`)[0]?.id ?? 0) as number;

/** Say the swap and answer both questions: ends on the confirm card (Monday only). */
async function toCard(t: ReturnType<typeof setup>) {
  await t.say("swap hack squat for cable row");
  const id = await pendingId();
  await t.tap(`sw:${id}:r`);
  await t.tap(`sw:${id}:d`);
  return id;
}

describe("swap questions", () => {
  it("asks the scope first, then the days, then shows one confirm card", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    await t.say("swap hack squat for cable row");
    expect(t.texts()[0]).toContain("For which sessions?");
    const id = await pendingId();
    expect(t.buttons(t.lastSent()).map((b) => b.data)).toEqual([
      `sw:${id}:t`,
      `sw:${id}:r`,
      `pa:${id}:no`,
    ]);

    await t.tap(`sw:${id}:r`);
    const days = t.edits().at(-1);
    expect(String(days?.payload.text)).toContain("Swap it on which days?");
    expect(t.buttons(days).map((b) => b.data)).toEqual([`sw:${id}:d`, `sw:${id}:a`, `pa:${id}:no`]);

    await t.tap(`sw:${id}:d`);
    const card = t.edits().at(-1);
    expect(String(card?.payload.text)).toContain("Save this?");
    expect(t.buttons(card).map((b) => b.data)).toEqual([
      `pa:${id}:ok`,
      `pa:${id}:ed`,
      `pa:${id}:no`,
    ]);
    expect(await count("plan_versions")).toBe(1);
  });

  it("both questions have a Cancel button that drops the request", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    await t.say("swap hack squat for cable row");
    const id = await pendingId();
    expect(t.buttons(t.lastSent()).at(-1)).toEqual({ text: "Cancel", data: `pa:${id}:no` });
    await t.tap(`sw:${id}:r`);
    expect(t.buttons(t.edits().at(-1)).at(-1)).toEqual({ text: "Cancel", data: `pa:${id}:no` });
    await t.tap(`pa:${id}:no`);
    expect((await sql`select status from pending_actions where id = ${id}`)[0]?.status).not.toBe(
      "open",
    );
    expect(await count("session_overrides")).toBe(0);
    expect(await count("plan_versions")).toBe(1);
  });

  it("an 'only today' answer goes straight to the card", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    await t.say("swap hack squat for cable row");
    const id = await pendingId();
    await t.tap(`sw:${id}:t`);
    expect(String(t.edits().at(-1)?.payload.text)).toContain("Save this?");
  });

  it("a scope said in the message skips the scope question", async () => {
    const t = setup([tool("swap_exercise", swapInput({ scope: "today" })), ok]);
    await t.say("swap hack squat for cable row today only");
    expect(t.texts()[0]).toContain("Save this?");
  });

  it("a stale or unknown sw: tap says it expired and changes nothing", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    await t.say("swap hack squat for cable row");
    const id = await pendingId();
    await t.tap(`pa:${id}:no`);
    await t.tap(`sw:${id}:t`);
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    await t.tap("sw:99999:t");
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    expect(await count("session_overrides")).toBe(0);
  });
});

describe("saving, echo and undo", () => {
  it("✅ saves version 2 for Mondays only, today's override, an Undo echo; a second ✅ adds nothing", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    const id = await toCard(t);
    await t.tap(`pa:${id}:ok`);
    expect(await count("plan_versions")).toBe(2);
    expect(await count("session_overrides")).toBe(1);
    const echo = t.lastSent();
    expect(String(echo?.payload.text)).toMatch(/^Saved\. From Tue 29 Sep, /);
    expect(t.buttons(echo).map((b) => b.data)).toEqual([`up:p:${id}:0`]);

    await t.tap(`pa:${id}:ok`);
    expect(await count("plan_versions")).toBe(2);
    expect(await count("session_overrides")).toBe(1);

    // Tuesday is untouched, today shows the one-off swap.
    await t.say("/today");
    expect(t.texts().at(-1)).toContain("instead of hack_squat today");
    await t.say("/session tue");
    expect(t.texts().at(-1)).toContain("hack_squat");
    expect(t.texts().at(-1)).not.toContain("cable_row");
    // Other Tuesdays keep it too; next Monday (from the new version) has the replacement.
    await t.say("/session 6/10");
    expect(t.texts().at(-1)).toContain("hack_squat");
    expect(t.texts().at(-1)).not.toContain("cable_row");
    await t.say("/session 5/10");
    expect(t.texts().at(-1)).toContain("cable_row");
  });

  it("/plan lists the change", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    const id = await toCard(t);
    await t.tap(`pa:${id}:ok`);
    await t.say("/plan");
    expect(t.texts().at(-1)).toContain(
      "<b>Changes</b>\n• From Tue 29 Sep: hack_squat → cable_row (Mon)",
    );
  });

  it("Undo right after ✅ restores the plan and drops the button", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    const id = await toCard(t);
    await t.tap(`pa:${id}:ok`);
    await t.tap(`up:p:${id}:0`, 1002);
    expect(await count("plan_versions")).toBe(1);
    expect(await count("session_overrides")).toBe(0);
    const last = t.edits().at(-1);
    expect(String(last?.payload.text)).toBe("Undone. The plan is back as it was.");
    expect(t.buttons(last)).toEqual([]);
    await t.tap(`up:p:${id}:0`, 1002);
    expect(t.answers().at(-1)?.payload.text).toBe("Already undone.");
    expect(t.sent().filter((c) => String(c.payload.text) === "Already undone.")).toHaveLength(0);
  });

  it("Undo after a log of the replacement is too late", async () => {
    const t = setup([
      tool("swap_exercise", swapInput()),
      ok,
      tool("log_sets", {
        exercise: { slug: "cable_row", said: "cable row" },
        sets: { count: 2, reps: 8, load_kg: 30 },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      ok,
    ]);
    const id = await toCard(t);
    await t.tap(`pa:${id}:ok`);
    await t.say("2x8 cable row 30");
    expect(await count("log_groups")).toBe(1);
    await t.tap(`up:p:${id}:0`, 1002);
    expect(t.answers().at(-1)?.payload.text).toMatch(/^Too late to undo/);
    expect(await count("plan_versions")).toBe(2);
  });

  it("a refused ✅ replies with the reason and retires the card", async () => {
    const t = setup([tool("swap_exercise", swapInput({ scope: "today" })), ok]);
    await t.say("swap hack squat for cable row today only");
    const id = await pendingId();
    // The exercise gets logged before the user confirms.
    const staged = await stageLogSets(
      db,
      {
        exercise: { slug: "hack_squat", said: "hack squat" },
        sets: { count: 2, reps: 6, load_kg: 40 },
        guessed_fields: [],
        needs_confirmation: false,
      },
      MON,
    );
    if (!staged.ok) throw new Error(staged.error);
    await executeActions(db, "u:1", [staged.action], { now: MON });
    await t.tap(`pa:${id}:ok`);
    const lastEdit = String(t.edits().at(-1)?.payload.text);
    expect(lastEdit).toBe("You already logged hack_squat today; nothing changed.");
    expect(await count("session_overrides")).toBe(0);
  });
});

describe("/swap and staging refusals", () => {
  it("/swap alone lists today's exercises", async () => {
    const t = setup();
    await t.say("/swap");
    expect(t.texts()[0]).toMatch(/^Tell me what to swap, e\.g\. .*Today: .*bench_press.*\.$/);
  });

  it("/swap <text> runs the normal pipeline", async () => {
    const t = setup([tool("swap_exercise", swapInput()), ok]);
    await t.say("/swap hack squat for cable row");
    expect(t.texts()[0]).toContain("For which sessions?");
  });

  it("a failed swap next to a clear log keeps the log behind a card that says so", async () => {
    const t = setup([
      tool("swap_exercise", swapInput({ exercise: { said: "unobtainium" } })),
      tool("log_sets", {
        exercise: { slug: "bench_press", said: "bench" },
        sets: { count: 2, reps: 6, load_kg: 55 },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      ok,
    ]);
    await t.say("swap unobtainium for cable row, and bench 2x6 55");
    expect(await count("log_groups")).toBe(0);
    expect(t.texts()[0]).toContain("part of your message couldn't be saved");
    expect(t.texts()[0]).toContain("Which exercise do you mean:");
  });

  it("an unreadable swap input gets the fixed sentence, not the model's claim", async () => {
    const t = setup([
      tool("swap_exercise", { exercise: { said: "hack squat" } }),
      turn(text("Done, swapped!")),
    ]);
    await t.say("swap hack squat");
    expect(t.texts()).toEqual(["I couldn't read that swap. Tell me the two exercise names again."]);
  });
});

describe("swap with other actions and refusals", () => {
  const benchLog = {
    exercise: { slug: "bench_press", said: "bench" },
    sets: { count: 2, reps: 6, load_kg: 55 },
    guessed_fields: [],
    needs_confirmation: false,
  };

  it("a swap staged with a clear log asks first, then one card for both", async () => {
    const t = setup([tool("swap_exercise", swapInput()), tool("log_sets", benchLog), ok]);
    await t.say("swap hack squat for cable row, and bench 2x6 55");
    expect(t.texts()[0]).toContain("For which sessions?");
    expect(await count("log_groups")).toBe(0);
    const id = await pendingId();
    await t.tap(`sw:${id}:t`);
    const card = String(t.edits().at(-1)?.payload.text);
    expect(card).toContain("Save this?");
    expect(card).toContain("Swap for");
    expect(card).toContain("bench");
    await t.tap(`pa:${id}:ok`);
    expect(await count("log_groups")).toBe(1);
    expect(await count("session_overrides")).toBe(1);
  });

  it("an unclear exercise plus a swap: after the choice the swap question still comes first", async () => {
    const t = setup([
      tool("log_sets", { ...benchLog, exercise: { said: "fp" } }),
      tool("swap_exercise", swapInput()),
      ok,
    ]);
    await t.say("fp 2x6 55, and swap hack squat for cable row");
    const id = await pendingId();
    const pick = t
      .buttons(t.lastSent())
      .find((b) => b.data.startsWith(`ex:${id}:`) && /face pull/i.test(b.text));
    expect(pick).toBeDefined();
    await t.tap(pick?.data ?? "");
    const after = t.edits().at(-1);
    expect(String(after?.payload.text)).toContain("For which sessions?");
    expect(t.buttons(after).map((b) => b.data)).toEqual([
      `sw:${id}:t`,
      `sw:${id}:r`,
      `pa:${id}:no`,
    ]);
    await t.tap(`sw:${id}:t`);
    expect(String(t.edits().at(-1)?.payload.text)).toContain("Save this?");
  });

  it("a lone refused swap shows the refusal text itself", async () => {
    const t = setup([
      tool(
        "swap_exercise",
        swapInput({ replacement: { said: "cable row", slug: "hspu_negative" } }),
      ),
      turn(text("Done, swapped!")),
    ]);
    await t.say("swap hack squat for an hspu step");
    expect(t.texts()[0]).toBe(
      "That is an HSPU step. The HSPU step is tracked from your logs, so I changed nothing.",
    );
  });
});
