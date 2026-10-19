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

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

function setup(script: ScriptedTurn[] = []) {
  const calls: Call[] = [];
  let mid = 1000;
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
  const fail = { edits: false };
  const bot = createBot({
    db,
    now: () => MON,
    token: "123:abc",
    botInfo,
    transformer,
    ai: { model: createFakeModel(script), dailyTokenCap: 1_000_000, monthlyTokenCap: 10_000_000 },
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
  const tap = (data: string, messageId = 1, updateId = ++uid, body = LIST) =>
    bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        chat_instance: "x",
        from: FROM,
        message: { message_id: messageId, date: 0, chat: CHAT_OBJ, text: body },
        data,
      },
    });
  const sent = () => calls.filter((c) => c.method === "sendMessage");
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  const answers = () =>
    calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text);
  const buttons = (c: Call | undefined): { text: string; data: string }[] =>
    (
      (c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data }));
  return { fail, say, tap, sent, edits, answers, buttons };
}

const itemId = async (order: number) =>
  ((await sql`select id from planned_items where item_key = ${`w01-mon-0${order}-0`}`)[0]?.id ??
    0) as number;
const rows = () => sql`select status, source from session_items order by planned_item_id`;
const BENCH = 3;
const LATERAL = 6;
const LIST = "Skip what? (Mon 28 Sep)";

describe("/skip", () => {
  it("lists open items, a tap skips one with an Undo button, Undo restores it", async () => {
    const t = setup();
    await t.say("/skip");
    const list = t.sent()[0];
    expect(String(list?.payload.text)).toBe("Skip what? (Mon 28 Sep)");
    const data = t.buttons(list).map((b) => b.data);
    expect(data).toContain(`sk:20260928:${await itemId(BENCH)}`);
    expect(data.at(-1)).toBe("sk:20260928:all");
    expect(t.buttons(list).at(-1)?.text).toBe("Whole session");

    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001, 2000);
    expect(await rows()).toMatchObject([{ status: "skipped", source: "bot" }]);
    // the echo is its own message; the list is edited in place to the remaining items
    const echo = t.sent().at(-1);
    expect(echo?.payload.text).toBe("Skipped: bench_press");
    expect(t.buttons(echo).map((b) => b.data)).toEqual(["us:u:2000:0"]);
    const refreshed = t.edits().at(-1);
    expect(refreshed?.payload.message_id).toBe(1001);
    expect(String(refreshed?.payload.text)).toBe(LIST);
    expect(t.buttons(refreshed).map((b) => b.data)).not.toContain(
      `sk:20260928:${await itemId(BENCH)}`,
    );

    await t.tap("us:u:2000:0", 1002);
    expect(await rows()).toEqual([]);
    expect(t.edits().at(-1)?.payload.message_id).toBe(1002);
    expect(t.edits().at(-1)?.payload.text).toBe("Skip undone: bench_press");
    expect(t.answers()).toContain("Skip undone.");
    await t.tap("us:u:2000:0", 1002);
    expect(t.answers().at(-1)).toBe("Nothing to undo.");
  });

  it("a retried tap update re-sends the echo and writes nothing twice", async () => {
    const t = setup();
    await t.say("/skip");
    const data = `sk:20260928:${await itemId(BENCH)}`;
    await t.tap(data, 1001, 2100);
    await t.tap(data, 1001, 2100);
    expect(await rows()).toMatchObject([{ status: "skipped" }]);
    expect(t.sent().at(-1)?.payload.text).toBe("Skipped: bench_press");
    expect(t.buttons(t.sent().at(-1))[0]?.data).toBe("us:u:2100:0");
  });

  it("a tap on an item that is no longer open says so and refreshes the list", async () => {
    const t = setup();
    await t.say("/skip");
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-09-28', ${await itemId(BENCH)}, 'done', 'bot')`;
    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001);
    expect(t.answers()).toContain("Already done or skipped.");
    const refreshed = t.edits().at(-1);
    expect(t.buttons(refreshed).map((b) => b.data)).not.toContain(
      `sk:20260928:${await itemId(BENCH)}`,
    );
    expect(await rows()).toMatchObject([{ status: "done" }]);
  });

  it("a PRIMARY item turns the list into a confirm card, and ✅ skips it", async () => {
    await sql`update planned_items set priority = 'PRIMARY' where id = ${await itemId(BENCH)}`;
    const t = setup();
    await t.say("/skip");
    const list = t.sent()[0];
    expect(t.buttons(list).some((b) => b.text === "⭐ bench_press")).toBe(true);

    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001);
    expect(await rows()).toEqual([]);
    const card = t.sent().at(-1);
    expect(String(card?.payload.text)).toContain("Skip this?\n• Bench press (PRIMARY)");
    expect(String(card?.payload.text)).toContain("skipping a PRIMARY item");
    const [ok] = t.buttons(card);
    expect(ok?.data).toMatch(/^pa:\d+:ok$/);
    const [pending] = await sql`select message_id, kind from pending_actions`;
    expect(pending).toMatchObject({ message_id: 1002, kind: "confirm" });
    // the list stays a list
    expect(String(t.edits().at(-1)?.payload.text)).toBe(LIST);

    await t.tap(ok?.data as string, 1002);
    expect(await rows()).toMatchObject([{ status: "skipped", source: "bot" }]);
    expect(t.edits().find((e) => e.payload.text === "Skipped ✓")?.payload.message_id).toBe(1002);
    const echo = t.sent().at(-1);
    expect(echo?.payload.text).toBe("Skipped: bench_press");
    expect(t.buttons(echo)[0]?.data).toMatch(/^us:p:\d+:0$/);
  });

  it("Whole session asks first", async () => {
    const t = setup();
    await t.say("/skip");
    await t.tap("sk:20260928:all", 1001);
    expect(await rows()).toEqual([]);
    const text = String(t.sent().at(-1)?.payload.text);
    expect(text).toContain("Skip this?\n• Whole session (Mon 28 Sep): Warm-up, ");
    expect(text).toContain("skipping the whole session");
  });

  it("says when there is no session", async () => {
    const t = setup();
    await sql`insert into session_items (session_date, planned_item_id, status, source) select '2026-09-28', id, 'done', 'import' from planned_items where week = 1 and weekday = 'mon'`;
    await t.say("/skip");
    expect(t.sent()[0]?.payload.text).toBe("Nothing left to skip today.");
  });

  it("free text: a staged skip is written at once with an Undo button", async () => {
    const t = setup([
      turn(toolUse("skip_items", { exercise: { slug: "lateral_raise", said: "lateral raises" } })),
      turn(text("")),
    ]);
    await t.say("I skipped lateral raises");
    expect(t.sent()[0]?.payload.text).toBe("Skipped: lateral_raise");
    expect(t.buttons(t.sent()[0])[0]?.data).toMatch(/^us:u:\d+:0$/);
    expect(await rows()).toMatchObject([{ status: "skipped" }]);
  });

  it("free text: no session today goes through a card", async () => {
    const t = setup([turn(toolUse("skip_items", { whole_session: true })), turn(text(""))]);
    await t.say("no session today");
    expect(String(t.sent()[0]?.payload.text)).toContain("Skip this?");
    expect(await rows()).toEqual([]);
  });

  it("a second tap before the list refreshed never edits the first echo", async () => {
    const t = setup();
    await t.say("/skip");
    const data = `sk:20260928:${await itemId(BENCH)}`;
    await t.tap(data, 1001, 3000);
    const echoId = 1002;
    await t.tap(data, 1001, 3002);
    expect(t.answers().at(-1)).toBe("Already done or skipped.");
    expect(t.edits().filter((e) => e.payload.message_id === echoId)).toEqual([]);
    expect(t.buttons(t.sent().at(-1))[0]?.data).toBe("us:u:3000:0");
  });

  it("a replaced card is retired and the new card says what it replaces", async () => {
    await sql`update planned_items set priority = 'PRIMARY' where id in (${await itemId(BENCH)}, ${await itemId(LATERAL)})`;
    const t = setup();
    await t.say("/skip");
    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001);
    await t.tap(`sk:20260928:${await itemId(LATERAL)}`, 1001);
    const card = t.sent().at(-1);
    expect(String(card?.payload.text)).toContain("Replaces: skip Bench press");
    expect(String(card?.payload.text)).toContain("Lateral raise (PRIMARY)");
    const old = t.edits().find((e) => e.payload.message_id === 1002);
    expect(String(old?.payload.text)).toContain("Replaced by a newer request");
  });

  it("✅ after the item was done meanwhile says nothing was skipped", async () => {
    await sql`update planned_items set priority = 'PRIMARY' where id = ${await itemId(BENCH)}`;
    const t = setup();
    await t.say("/skip");
    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001);
    const ok = t.buttons(t.sent().at(-1))[0]?.data as string;
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-09-28', ${await itemId(BENCH)}, 'done', 'bot')`;
    await t.tap(ok, 1002);
    expect(t.edits().find((e) => e.payload.message_id === 1002)?.payload.text).toBe(
      "Nothing skipped ✓",
    );
    expect(await rows()).toMatchObject([{ status: "done" }]);
    const [last] = await sql`select text from conversation_messages order by id desc limit 1`;
    expect(last?.text).toBe("Nothing skipped (user confirmed): already done or skipped.");
  });

  it("a tap from another day's list writes nothing and drops the buttons", async () => {
    const t = setup();
    await t.tap(`sk:20260929:${await itemId(BENCH)}`, 1001);
    expect(await rows()).toEqual([]);
    const e = t.edits().at(-1);
    expect(e?.payload.text).toBe("This list is from another day. Send /skip again.");
    expect(t.buttons(e)).toEqual([]);
  });

  it("a failing list refresh does not lose the echo, and Undo still works", async () => {
    const t = setup();
    await t.say("/skip");
    t.fail.edits = true;
    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001, 3100);
    expect(await rows()).toMatchObject([{ status: "skipped" }]);
    const echo = t.sent().at(-1);
    expect(echo?.payload.text).toBe("Skipped: bench_press");
    expect(t.buttons(echo).map((b) => b.data)).toEqual(["us:u:3100:0"]);
    await t.tap("us:u:3100:0", 1002);
    expect(await rows()).toEqual([]);
    expect(t.sent().at(-1)?.payload.text).toBe("Skip undone: bench_press");
  });

  it("a second ✅ on an empty skip card keeps 'Nothing skipped'", async () => {
    await sql`update planned_items set priority = 'PRIMARY' where id = ${await itemId(BENCH)}`;
    const t = setup();
    await t.say("/skip");
    await t.tap(`sk:20260928:${await itemId(BENCH)}`, 1001);
    const ok = t.buttons(t.sent().at(-1))[0]?.data as string;
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-09-28', ${await itemId(BENCH)}, 'done', 'bot')`;
    await t.tap(ok, 1002);
    await t.tap(ok, 1002);
    const card = t.edits().filter((e) => e.payload.message_id === 1002);
    expect(card.map((e) => e.payload.text)).toEqual(["Nothing skipped ✓", "Nothing skipped ✓"]);
    const [last] = await sql`select text from conversation_messages order by id desc limit 1`;
    expect(last?.text).toBe("A tapped button was too late: nothing was skipped.");
  });

  it("free text: a real skip keeps its Saved memory line", async () => {
    const t = setup([
      turn(toolUse("skip_items", { exercise: { slug: "lateral_raise", said: "lateral" } })),
      turn(text("")),
    ]);
    await t.say("I skipped lateral");
    const [last] = await sql`select text from conversation_messages order by id desc limit 1`;
    expect(String(last?.text)).toMatch(/^Saved: skip Lateral raise/);
  });
});
