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
import { BUDGET_REACHED, EXPIRED, STALE } from "../../src/bot/log-format.js";
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
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
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
  return { calls, model, say, tap, sent, edits, answers, texts, buttons, lastSent };
}

const tool = (name: string, input: unknown) => turn(toolUse(name, input));
const ok = turn(text("ok"));
const nothing = turn(text(""));

const log = (slug: string, sets: unknown, extra: Record<string, unknown> = {}) => ({
  exercise: { slug, said: slug },
  sets,
  guessed_fields: [],
  needs_confirmation: false,
  ...extra,
});
const squatLog = () => log("squat", { count: 3, reps: 8, load_kg: 60 }, { rir: 2 });
const benchLog = () => log("bench_press", { count: 2, reps: 6, load_kg: 55 });
const lateralLog = () => log("lateral_raise", { count: 2, reps: 15, load_kg: 6 });

const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;

describe("direct logging", () => {
  it("saves a clear log at once with an Undo button and no RIR row", async () => {
    const t = setup([tool("log_sets", squatLog()), ok]);
    await t.say("3x8 squat 60 rir 2");
    expect(await count("log_groups")).toBe(1);
    expect(t.sent()).toHaveLength(1);
    expect(t.texts()[0]).toBe("✓ squat — 3 × 8 · 60 kg · RIR 2 · Mon W1");
    expect(t.buttons(t.lastSent()).map((b) => b.data)).toEqual([expect.stringMatching(/^ug:\d+$/)]);
    const [si] = await sql`select status, source from session_items`;
    expect(si).toMatchObject({ status: "done", source: "bot" });
    const msgs = await sql`select role from conversation_messages order by id`;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("asks RIR, and the tap writes it and drops the row", async () => {
    const t = setup([tool("log_sets", benchLog()), ok]);
    await t.say("bench 2x6 55");
    const rir = t.buttons(t.lastSent()).filter((b) => b.data.startsWith("rir:"));
    expect(rir.map((b) => b.text)).toEqual(["0", "1", "2", "3", "4+"]);
    expect(t.texts()[0]).toContain("RIR on the last set?");
    await t.tap(rir[2]?.data as string, 1001);
    const rows = await sql`select set_index, rir, rir_plus from log_entries order by set_index`;
    expect(rows.map((r) => (r.rir === null ? null : Number(r.rir)))).toEqual([null, 2]);
    const edit = t.edits().at(-1);
    expect(String(edit?.payload.text)).toContain("RIR 2");
    expect(t.buttons(edit).map((b) => b.data.split(":")[0])).toEqual(["ug"]);
  });

  it("4+ stores rir 4 with the plus flag", async () => {
    const t = setup([tool("log_sets", benchLog()), ok]);
    await t.say("bench 2x6 55");
    const four = t.buttons(t.lastSent()).find((b) => b.text === "4+");
    await t.tap(four?.data as string);
    const [r] = await sql`select rir, rir_plus from log_entries where set_index = 2`;
    expect(Number(r?.rir)).toBe(4);
    expect(r?.rir_plus).toBe(true);
  });

  it("the Undo button removes the group; a second tap says already removed", async () => {
    const t = setup([tool("log_sets", squatLog()), ok]);
    await t.say("3x8 squat 60 rir 2");
    const undo = t.buttons(t.lastSent())[0]?.data as string;
    await t.tap(undo);
    expect(await count("log_groups")).toBe(0);
    expect(await count("session_items")).toBe(0);
    expect(String(t.edits().at(-1)?.payload.text)).toBe("Removed: squat 3 × 8 · 60 kg");
    await t.tap(undo);
    expect(t.answers().at(-1)?.payload.text).toBe("Already removed.");
    expect(await count("log_groups")).toBe(0);
  });

  it("a pull-up without clean gets the clean row; the tap cleans every set", async () => {
    const t = setup([tool("log_sets", log("pull_up", { count: 3, reps: 5 }, { rir: 2 })), ok]);
    await t.say("pull ups 3x5");
    const clean = t.buttons(t.lastSent()).filter((b) => b.data.startsWith("cl:"));
    expect(clean.map((b) => b.text)).toEqual(["Clean ✓", "Not clean"]);
    await t.tap(clean[0]?.data as string);
    const rows = await sql`select clean from log_entries`;
    expect(rows.map((r) => r.clean)).toEqual([true, true, true]);
    expect(t.buttons(t.edits().at(-1)).map((b) => b.data.split(":")[0])).toEqual(["ug"]);
  });

  it("edits the last entry and Undo restores it", async () => {
    const t = setup([
      tool("log_sets", benchLog()),
      ok,
      tool("edit_last_entry", {
        changes: { load_kg: 57.5 },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      ok,
    ]);
    await t.say("bench 2x6 55");
    await t.say("no it was 57.5");
    expect(t.texts().at(-1)).toBe("Changed: bench_press sets 1–2 55 → 57.5 kg");
    const loads = async () =>
      (await sql`select load_kg from log_entries order by set_index`).map((r) => Number(r.load_kg));
    expect(await loads()).toEqual([57.5, 57.5]);
    const undo = t.buttons(t.lastSent())[0]?.data as string;
    expect(undo).toMatch(/^ue:u:\d+:0$/);
    await t.tap(undo);
    expect(await loads()).toEqual([55, 55]);
    expect(String(t.edits().at(-1)?.payload.text)).toMatch(/^Change undone: /);
  });

  it("same update delivered twice: one group, no second model call", async () => {
    const t = setup([tool("log_sets", squatLog()), ok]);
    await t.say("3x8 squat 60 rir 2", 5000);
    await t.say("3x8 squat 60 rir 2", 5000);
    expect(await count("log_groups")).toBe(1);
    expect(t.model.requests).toHaveLength(2); // the first run only
  });
});

describe("confirm cards", () => {
  const two = () => [turn(toolUse("log_sets", benchLog()), toolUse("log_sets", lateralLog())), ok];

  it("two log_sets: a card; ✅ writes both; ✅ again writes nothing", async () => {
    const t = setup(two());
    await t.say("bench 55 and lateral raise 2x15 6");
    expect(t.texts()[0]).toContain("Save this?");
    expect(t.texts()[0]).toContain("more than one change");
    expect(await count("log_groups")).toBe(0);
    const ids = t.buttons(t.lastSent()).map((b) => b.data);
    expect(ids).toHaveLength(3);
    const okData = ids[0] as string;
    await t.tap(okData, 1001);
    expect(await count("log_groups")).toBe(2);
    expect(String(t.edits().at(-1)?.payload.text)).toBe("Saved ✓");
    expect(t.sent()).toHaveLength(3); // card + 2 echoes
    await t.tap(okData, 1001);
    expect(await count("log_groups")).toBe(2);
    expect(await count("write_ledger")).toBe(2);
    expect(t.answers().at(-1)?.payload.text).toBe("Already saved.");
  });

  it("the same update delivered twice makes one pending and one card", async () => {
    const t = setup(two());
    await t.say("bench and lateral", 7000);
    await t.say("bench and lateral", 7000);
    expect(await count("pending_actions")).toBe(1);
    expect(t.sent()).toHaveLength(1);
    expect(t.model.requests).toHaveLength(2);
  });

  it("a second card replaces the first; the old ✅ is stale", async () => {
    const t = setup([...two(), ...two()]);
    await t.say("first");
    const oldOk = t.buttons(t.lastSent())[0]?.data as string;
    await t.say("second");
    expect(t.texts()[1]).toContain("Replaces: ");
    await t.tap(oldOk, 1001);
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    expect(t.texts().at(-1)).toBe(EXPIRED);
    expect(await count("log_groups")).toBe(0);
    const newOk = t.buttons(t.sent()[1])[0]?.data as string;
    await t.tap(newOk, 1002);
    expect(await count("log_groups")).toBe(2);
  });

  it("an expired pending is not written", async () => {
    const t = setup(two());
    await t.say("bench and lateral");
    const okData = t.buttons(t.lastSent())[0]?.data as string;
    clock = new Date(clock.getTime() + 31 * 60_000);
    await t.tap(okData, 1001);
    expect(await count("log_groups")).toBe(0);
    expect(t.texts().at(-1)).toBe(EXPIRED);
  });

  it("✏️ then a correction replaces the card and says so", async () => {
    const t = setup([...two(), ...two()]);
    await t.say("first");
    const [, edit] = t.buttons(t.lastSent());
    await t.tap(edit?.data as string, 1001);
    expect(t.texts().at(-1)).toBe("OK, tell me what to change.");
    const [p] = await sql`select awaiting_edit from pending_actions`;
    expect(p?.awaiting_edit).toBe(true);
    await t.say("actually different");
    expect(t.texts().at(-1)).toContain("Replaces: ");
    const statuses = await sql`select status from pending_actions order by id`;
    expect(statuses.map((s) => s.status)).toEqual(["replaced", "open"]);
  });

  it("❌ cancels", async () => {
    const t = setup(two());
    await t.say("bench and lateral");
    const no = t.buttons(t.lastSent())[2]?.data as string;
    await t.tap(no, 1001);
    expect(String(t.edits().at(-1)?.payload.text)).toBe("Cancelled, nothing saved.");
    expect(await count("log_groups")).toBe(0);
  });

  it("a far-off load asks first and says why", async () => {
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 60 }, { rir: 2 })),
      ok,
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 100 }, { rir: 2 })),
      ok,
    ]);
    await t.say("3x8 squat 60 rir 2");
    expect(await count("log_groups")).toBe(1);
    await t.say("3x8 squat 100 rir 2");
    expect(await count("log_groups")).toBe(1);
    expect(t.texts().at(-1)).toContain("far from last time: 100 kg");
  });
});

describe("clarify and aliases", () => {
  it("asks which exercise, saves the alias, writes the log, then never asks again", async () => {
    const said = {
      exercise: { said: "sq" },
      sets: { count: 3, reps: 8, load_kg: 60 },
      rir: 2,
      guessed_fields: [],
      needs_confirmation: false,
    };
    const t = setup([tool("log_sets", said), nothing, tool("log_sets", said), ok]);
    await t.say("sq 3x8 60 rir 2");
    expect(t.texts()[0]).toBe('Which exercise is "sq"?');
    const btns = t.buttons(t.lastSent());
    const squat = btns.find((b) => b.text === "squat");
    expect(squat?.data).toMatch(/^ex:\d+:\d+$/);
    expect(btns.at(-1)?.data).toMatch(/^pa:\d+:no$/);
    await t.tap(squat?.data as string, 1001);

    expect(await count("log_groups")).toBe(1);
    expect(t.texts().some((x) => x === 'Saved: "sq" = squat')).toBe(true);
    const aliasMsg = t.sent().find((c) => String(c.payload.text).startsWith("Saved:"));
    expect(t.buttons(aliasMsg)[0]?.data).toMatch(/^md:\d+$/);
    expect(t.texts().at(-1)).toContain("✓ squat — 3 × 8 · 60 kg · RIR 2 · Mon W1");
    const [p] = await sql`select status from pending_actions`;
    expect(p?.status).toBe("executed");

    const before = t.sent().length;
    await t.say("sq 3x8 60 rir 2");
    expect(t.sent().length).toBe(before + 1);
    expect(t.texts().at(-1)).toContain("✓ squat");
    expect(await count("log_groups")).toBe(2);
  });

  it("an exercise outside today's session turns into a confirm card after the answer", async () => {
    const said = {
      exercise: { said: "fp" },
      sets: { count: 2, reps: 15, load_kg: 25 },
      guessed_fields: [],
      needs_confirmation: false,
    };
    const t = setup([tool("log_sets", said), nothing]);
    await t.say("fp 2x15 25");
    const face = t.buttons(t.lastSent()).find((b) => b.text === "Face pull");
    await t.tap(face?.data as string, 1001);
    const card = String(t.edits().at(-1)?.payload.text);
    expect(card).toContain("Save this?");
    expect(card).toContain("not in today's session");
    expect(await count("log_groups")).toBe(0);
    const [p] = await sql`select kind, status from pending_actions`;
    expect(p).toMatchObject({ kind: "confirm", status: "open" });
    const okBtn = t.buttons(t.edits().at(-1))[0]?.data as string;
    await t.tap(okBtn, 1001);
    expect(await count("log_groups")).toBe(1);
    const [al] = await sql`select content from memory_items where active`;
    expect(al?.content).toBe('"fp" = Face pull');
  });

  it("the alias Undo deletes it; /memory lists and deletes", async () => {
    const said = {
      exercise: { said: "sq" },
      sets: { count: 3, reps: 8, load_kg: 60 },
      rir: 2,
      guessed_fields: [],
      needs_confirmation: false,
    };
    const t = setup([tool("log_sets", said), nothing]);
    await t.say("sq 3x8 60 rir 2");
    const squat = t.buttons(t.lastSent()).find((b) => b.text === "squat");
    await t.tap(squat?.data as string, 1001);
    await t.say("/memory");
    const list = t.lastSent();
    expect(String(list?.payload.text)).toContain('"sq" = squat');
    const del = t.buttons(list)[0]?.data as string;
    await t.tap(del, 2000);
    expect((await sql`select 1 from memory_items where active`).length).toBe(0);
    expect(t.answers().at(-1)?.payload.text).toBe("Deleted.");
    await t.tap(del, 2000);
    expect(t.answers().at(-1)?.payload.text).toBe("Already deleted.");
    await t.say("/memory");
    expect(t.texts().at(-1)).toBe("I don't know anything about you yet.");
  });
});

describe("/undo", () => {
  it("asks, removes the group and the session item, and /today shows it open again", async () => {
    const t = setup([tool("log_sets", squatLog()), ok]);
    await t.say("3x8 squat 60 rir 2");
    await t.say("/today");
    expect(t.texts().at(-1)).toContain("✓");
    await t.say("/undo");
    expect(t.texts().at(-1)).toBe("Remove squat 3 × 8 · 60 kg (today 10:00)?");
    const [yes] = t.buttons(t.lastSent());
    expect(await count("log_groups")).toBe(1);
    await t.tap(yes?.data as string, 1005);
    expect(await count("log_groups")).toBe(0);
    expect(await count("session_items")).toBe(0);
    expect(t.texts().at(-1)).toBe("Removed: squat 3 × 8 · 60 kg");
    await t.say("/today");
    expect(t.texts().at(-1)).not.toContain("✓");
  });

  it("says so when there is nothing to undo", async () => {
    const t = setup();
    await t.say("/undo");
    expect(t.texts()).toEqual(["Nothing to undo."]);
  });
});

describe("AI budget", () => {
  it("replies and never calls the model", async () => {
    await sql`insert into usage_logs (date, model, input_tokens, output_tokens) values ('2026-09-28', 'm', 900, 200)`;
    const t = setup([tool("log_sets", squatLog()), ok], { daily: 1000, monthly: 1_000_000 });
    await t.say("3x8 squat 60");
    expect(t.texts()).toEqual([BUDGET_REACHED]);
    expect(t.model.requests).toHaveLength(0);
    expect(await count("log_groups")).toBe(0);
  });
});

const editCall = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  tool("edit_last_entry", { changes, guessed_fields: [], needs_confirmation: false, ...extra });
const facePull = (load: number) => log("face_pull", { count: 1, reps: 15, load_kg: load });
const sawToolError = (t: ReturnType<typeof setup>, fragment: string) =>
  t.model.messageSnapshots
    .flat()
    .some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some(
          (b) =>
            b.type === "tool_result" && b.is_error === true && JSON.stringify(b).includes(fragment),
        ),
    );

describe("corrections while a request is open (B1)", () => {
  it("never edits a saved log; restating replaces the card silently", async () => {
    const t = setup([
      tool("log_sets", squatLog()),
      ok,
      tool("log_sets", facePull(20)),
      ok,
      editCall({ load_kg: 22.5 }),
      turn(text("Please restate it.")),
      editCall({ load_kg: 22.5 }),
      turn(text("Please restate it.")),
      tool("log_sets", facePull(22.5)),
      ok,
    ]);
    await t.say("3x8 squat 60 rir 2");
    await t.say("15 face pulls 20 kg");
    expect(t.texts().at(-1)).toContain("Save this?");

    // No ✏️ yet: the edit is refused and the card stays.
    await t.say("22.5");
    expect(sawToolError(t, "unsaved request")).toBe(true);
    expect(sawToolError(t, "Restate the full corrected request with log_sets")).toBe(true);
    const squatLoads = async () =>
      (
        await sql`select load_kg::float8 as l from log_entries e join log_groups g on g.id = e.group_id join exercises x on x.id = g.exercise_id where x.slug = 'squat'`
      ).map((r) => r.l);
    expect(await squatLoads()).toEqual([60, 60, 60]);
    expect((await sql`select status, awaiting_edit from pending_actions`)[0]).toMatchObject({
      status: "open",
      awaiting_edit: false,
    });

    // With ✏️ it is the same: refused, card still open.
    const card = t.sent().find((c) => String(c.payload.text).includes("Save this?"));
    await t.tap(t.buttons(card)[1]?.data as string, 1001);
    await t.say("22.5");
    expect(await squatLoads()).toEqual([60, 60, 60]);
    expect((await sql`select status, awaiting_edit from pending_actions`)[0]).toMatchObject({
      status: "open",
      awaiting_edit: true,
    });
    expect(await count("log_groups")).toBe(1);

    // Restating with log_sets replaces the card and says so.
    await t.say("face pulls 22.5");
    expect(t.texts().at(-1)).toContain("Save this?");
    expect(t.texts().at(-1)).toContain("Replaces: ");
    expect(
      (await sql`select status from pending_actions order by id`).map((r) => r.status),
    ).toEqual(["replaced", "open"]);
    expect(await squatLoads()).toEqual([60, 60, 60]);
  });

  it("announces the cancelled request when a non-✏️ card is replaced", async () => {
    const t = setup([tool("log_sets", facePull(20)), ok, tool("log_sets", facePull(25)), ok]);
    await t.say("face pulls 20");
    await t.say("face pulls 25");
    expect(t.texts().at(-1)).toContain("Replaces: ");
  });
});

describe("retries and stale buttons", () => {
  const said = {
    exercise: { said: "sq" },
    sets: { count: 3, reps: 8, load_kg: 60 },
    rir: 2,
    guessed_fields: [],
    needs_confirmation: false,
  };

  it("the same exercise tap handled twice writes once and never says expired (M1)", async () => {
    const t = setup([tool("log_sets", said), nothing]);
    await t.say("sq 3x8 60 rir 2");
    const squat = t.buttons(t.lastSent()).find((b) => b.text === "squat");
    await t.tap(squat?.data as string, 1001, 8000);
    await t.tap(squat?.data as string, 1001, 8000);
    expect(await count("log_groups")).toBe(1);
    expect(t.answers().some((a) => a.payload.text === EXPIRED)).toBe(false);
    expect(t.texts().includes(EXPIRED)).toBe(false);
    expect(t.answers().at(-1)?.payload.text).toBe("Already saved.");
    expect((await sql`select 1 from memory_items where active`).length).toBe(1);
  });

  it("an expired clarify saves no alias (m10)", async () => {
    const t = setup([tool("log_sets", said), nothing]);
    await t.say("sq 3x8 60 rir 2");
    const squat = t.buttons(t.lastSent()).find((b) => b.text === "squat");
    clock = new Date(clock.getTime() + 31 * 60_000);
    await t.tap(squat?.data as string, 1001);
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    expect(await count("memory_items")).toBe(0);
    expect(await count("log_groups")).toBe(0);
  });

  it("✏️ on an expired card says expired and marks nothing (m6)", async () => {
    const t = setup([tool("log_sets", facePull(20)), ok]);
    await t.say("face pulls 20");
    const card = t.lastSent();
    clock = new Date(clock.getTime() + 31 * 60_000);
    await t.tap(t.buttons(card)[1]?.data as string, 1001);
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    expect((await sql`select awaiting_edit from pending_actions`)[0]?.awaiting_edit).toBe(false);
  });

  it("a retried edit keeps its Undo button, rebuilt from the ledger (m8)", async () => {
    const t = setup([tool("log_sets", benchLog()), ok, editCall({ load_kg: 57.5 }), ok]);
    await t.say("bench 2x6 55");
    await t.say("no it was 57.5", 6000);
    const first = t.lastSent();
    await t.say("no it was 57.5", 6000);
    const again = t.lastSent();
    expect(again).not.toBe(first);
    expect(String(again?.payload.text)).toBe(String(first?.payload.text));
    expect(t.buttons(again).map((b) => b.data)).toEqual(["ue:u:6000:0"]);
    expect(t.model.requests).toHaveLength(4);
  });

  it("✅ on an edit whose log is gone: clear message, nothing written, no retry (m5)", async () => {
    const t = setup([
      tool("log_sets", benchLog()),
      ok,
      editCall({ load_kg: 57.5 }, { needs_confirmation: true }),
      ok,
    ]);
    await t.say("bench 2x6 55");
    await t.say("it was 57.5");
    expect(t.texts().at(-1)).toContain("Save this?");
    const okBtn = t.buttons(t.lastSent())[0]?.data as string;
    await sql`delete from log_groups`;
    await t.tap(okBtn, 1002);
    expect(String(t.edits().at(-1)?.payload.text)).toBe(STALE);
    expect((await sql`select status from pending_actions`)[0]?.status).toBe("cancelled");
    expect(await count("write_ledger")).toBe(1);
  });

  it("Undo of an edit is refused once the log changed again (m3)", async () => {
    const t = setup([
      tool("log_sets", benchLog()),
      ok,
      editCall({ load_kg: 57.5 }),
      ok,
      editCall({ load_kg: 60 }),
      ok,
    ]);
    await t.say("bench 2x6 55");
    await t.say("57.5", 6100);
    const firstUndo = t.buttons(t.lastSent())[0]?.data as string;
    await t.say("60", 6200);
    await t.tap(firstUndo, 1003);
    expect(t.answers().at(-1)?.payload.text).toBe("Can't undo: this log changed since.");
    const loads = await sql`select load_kg::float8 as l from log_entries order by set_index`;
    expect(loads.map((r) => r.l)).toEqual([60, 60]);
  });
});

describe("an open request blocks direct writes (round 2)", () => {
  const two = () => turn(toolUse("log_sets", benchLog()), toolUse("log_sets", lateralLog()));

  it("✏️ then restating only bench: a new card with Replaces, nothing written", async () => {
    const t = setup([
      two(),
      ok,
      tool("log_sets", log("bench_press", { count: 2, reps: 6, load_kg: 57.5 })),
      ok,
    ]);
    await t.say("bench 55 and lateral raise 2x15 6");
    const first = t.lastSent();
    await t.tap(t.buttons(first)[1]?.data as string, 1001);
    await t.say("bench was 57.5");
    const card = String(t.texts().at(-1));
    expect(card).toContain("Save this?");
    expect(card).toContain("Replaces: ");
    expect(card).toContain("lateral_raise");
    expect(card).toContain("57.5 kg");
    expect(await count("log_groups")).toBe(0);
    // the old card is retired
    const retired = t.edits().find((c) => c.payload.text === "Replaced by a newer request.");
    expect(retired?.payload.message_id).toBe(1001);
    expect(
      (await sql`select status from pending_actions order by id`).map((r) => r.status),
    ).toEqual(["replaced", "open"]);
  });

  it("a restatement without ✏️ gives a new card; the old ✅ is dead; one group at the end", async () => {
    const t = setup([
      tool("log_sets", log("face_pull", { count: 1, reps: 15, load_kg: 20 })),
      ok,
      tool("log_sets", log("face_pull", { count: 1, reps: 15, load_kg: 22.5 })),
      ok,
    ]);
    await t.say("15 face pulls 20 kg");
    const oldOk = t.buttons(t.lastSent())[0]?.data as string;
    await t.say("sorry, 22.5");
    expect(t.texts().at(-1)).toContain("Replaces: ");
    const newOk = t.buttons(t.lastSent())[0]?.data as string;
    await t.tap(oldOk, 1001);
    expect(t.answers().at(-1)?.payload.text).toBe(EXPIRED);
    expect(await count("log_groups")).toBe(0);
    await t.tap(newOk, 1002);
    expect(await count("log_groups")).toBe(1);
    const [e] = await sql`select load_kg::float8 as l from log_entries`;
    expect(e?.l).toBe(22.5);
  });

  it("/undo with an open card says what it replaces", async () => {
    const t = setup([tool("log_sets", squatLog()), ok, two(), ok]);
    await t.say("3x8 squat 60 rir 2");
    await t.say("bench and lateral");
    await t.say("/undo");
    expect(t.texts().at(-1)).toContain("Replaces: ");
    expect(t.texts().at(-1)).toContain("Remove ");
  });

  it("without an open request a clear log is still direct", async () => {
    const t = setup([tool("log_sets", squatLog()), ok]);
    await t.say("3x8 squat 60 rir 2");
    expect(await count("log_groups")).toBe(1);
  });

  it("✏️ on a clarify card says to use the buttons; a late ex: tap says already answered", async () => {
    const said = {
      exercise: { said: "fp" },
      sets: { count: 2, reps: 15, load_kg: 25 },
      guessed_fields: [],
      needs_confirmation: false,
    };
    const t = setup([tool("log_sets", said), nothing]);
    await t.say("fp 2x15 25");
    const clarify = t.lastSent();
    // no ✏️ button on a clarify card; a stray tap must not mark it awaiting edit
    await t.tap("pa:1:ed", 1001);
    expect(t.texts().at(-1)).toBe("Pick one of the buttons above, or send a new message.");
    expect((await sql`select awaiting_edit from pending_actions`)[0]?.awaiting_edit).toBe(false);
    const face = t.buttons(clarify).find((b) => b.text === "Face pull");
    await t.tap(face?.data as string, 1001);
    expect(String(t.edits().at(-1)?.payload.text)).toContain("Save this?");
    await t.tap(face?.data as string, 1001);
    expect(t.answers().at(-1)?.payload.text).toBe("Already answered.");
    expect(await count("log_groups")).toBe(0);
  });
});
