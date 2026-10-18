import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeModel, type ScriptedTurn, toolUse, turn } from "../../src/ai/fake-model.js";
import { createBot } from "../../src/bot/bot.js";
import { BOARD_UNREADABLE, PHOTO_FAILED } from "../../src/bot/log-format.js";
import type { MediaSource } from "../../src/bot/logging-flow.js";
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

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

type Call = { method: string; payload: Record<string, unknown> };

function setup(script: ScriptedTurn[], opts: { now?: Date; downloadFails?: boolean } = {}) {
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
  const download = vi.fn(async () => {
    if (opts.downloadFails) throw new Error("boom");
    return new Uint8Array([1, 2, 3]);
  });
  const media: MediaSource = { download };
  const bot = createBot({
    db,
    now: () => opts.now ?? MON,
    token: "123:abc",
    botInfo,
    transformer,
    ai: { model, dailyTokenCap: 1_000_000, monthlyTokenCap: 10_000_000 },
    media,
  });
  let uid = 2000;
  const photo = (caption?: string, updateId = ++uid) =>
    bot.handleUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: CHAT_OBJ,
        from: FROM,
        photo: [
          { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
          { file_id: "big", file_unique_id: "b", width: 1280, height: 960 },
        ],
        ...(caption ? { caption } : {}),
      },
    });
  const tap = (data: string, messageId: number, updateId = ++uid) =>
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
  const texts = () => sent().map((c) => String(c.payload.text));
  const buttons = (c: Call | undefined): { text: string; data: string }[] =>
    (
      (c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data }));
  return { model, download, photo, tap, sent, texts, buttons };
}

const board = (extra: Record<string, unknown> = {}) =>
  turn(
    toolUse("record_board", {
      is_board: true,
      moves: [
        { name: "Pull-ups", sets: 4, reps: 6, groups: ["pull"] },
        { name: "Push-ups", sets: 3, reps: 15, groups: ["push"] },
        { name: "Squat", sets: 5, reps: 8, groups: ["legs"] },
      ],
      ...extra,
    }),
  );
const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;
const FRI = new Date("2026-10-23T08:00:00Z");

describe("blackboard photo", () => {
  it("card with breakdown and nothing ticked; Save with mask 0", async () => {
    const t = setup([board()]);
    await t.photo();
    const card = t.sent().at(-1);
    const txt = String(card?.payload.text);
    expect(txt).toContain("Pull: 1 move, 4 sets");
    expect(txt).toContain("Push: 1 move, 3 sets");
    expect(txt).toContain("Legs: 1 move, 5 sets");
    expect(t.buttons(card).some((b) => b.text.includes("✓"))).toBe(false);
    const [p] = await sql`select input_source from pending_actions`;
    expect(p?.input_source).toBe("photo");
    expect(await count("class_logs")).toBe(0);
    const save = t.buttons(card).find((b) => b.text === "Save");
    await t.tap(save?.data as string, 1001);
    const [r] = await sql`select heavy_groups, photo_file_id from class_logs`;
    expect(r?.heavy_groups).toEqual([]);
    expect(r?.photo_file_id).toBe("big");
    expect(t.download).toHaveBeenCalledWith("big", 3.5 * 1024 * 1024);
  });

  it("caption naming legs starts with Legs ticked and raw_text is saved", async () => {
    const t = setup([board({ heavy_groups_from_caption: ["legs"] })]);
    await t.photo("legs were heavy");
    const card = t.sent().at(-1);
    expect(t.buttons(card).find((b) => b.text.includes("✓"))?.text).toContain("Legs");
    const save = t.buttons(card).find((b) => b.text === "Save");
    await t.tap(save?.data as string, 1001);
    const [r] = await sql`select heavy_groups, raw_text from class_logs`;
    expect(r?.heavy_groups).toEqual(["legs"]);
    expect(r?.raw_text).toBe("legs were heavy");
  });

  it("no caption: model-claimed heavy groups are ignored", async () => {
    for (const caption of [undefined, "   "]) {
      await resetAndSeed(db, sql);
      const t = setup([board({ heavy_groups_from_caption: ["legs"] })]);
      await t.photo(caption);
      expect(t.buttons(t.sent().at(-1)).some((b) => b.text.includes("✓"))).toBe(false);
    }
  });

  it("not a board: BOARD_UNREADABLE, no pending row", async () => {
    const t = setup([turn(toolUse("record_board", { is_board: false }))]);
    await t.photo();
    expect(t.texts()).toEqual([BOARD_UNREADABLE]);
    expect(await count("pending_actions")).toBe(0);
  });

  it("retry after the card: model called once", async () => {
    const t = setup([board()]);
    await t.photo(undefined, 3000);
    await t.photo(undefined, 3000);
    expect(t.model.requests.length).toBe(1);
    expect(t.download).toHaveBeenCalledTimes(1);
    expect(t.sent().length).toBe(1);
  });

  it("on Friday logs Thursday's class", async () => {
    const t = setup([board()], { now: FRI });
    await t.photo();
    const [p] = await sql`select actions from pending_actions`;
    expect((p?.actions as { date: string }[] | undefined)?.[0]?.date).toBe("2026-10-22");
  });

  it("download or vision failure: PHOTO_FAILED, no pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup([board()], { downloadFails: true });
    await t.photo();
    expect(t.texts()).toEqual([PHOTO_FAILED]);
    const v = setup([]);
    await v.photo();
    expect(v.texts()).toEqual([PHOTO_FAILED]);
    expect(await count("pending_actions")).toBe(0);
  });
});
