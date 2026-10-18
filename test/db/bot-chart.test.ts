import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../../src/bot/bot.js";
import { connect, exId, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
async function group(slug: string, date: string, sets: { reps: number; load: number }[]) {
  const exerciseId = await exId(sql, slug);
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, exercise_id, source)
    values (${date}, ${`${date}T08:00:00Z`}, ${exerciseId}, 'text') returning id`;
  for (const [i, s] of sets.entries()) {
    await sql`insert into log_entries (group_id, set_index, reps, load_kg, rir)
      values (${g?.id}, ${i + 1}, ${s.reps}, ${s.load}, 2)`;
  }
}

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`update exercises set muscle_group = 'quads', is_main_lift = true where slug = 'squat'`;
  await group("squat", "2026-10-05", [{ reps: 5, load: 80 }]);
  await group("squat", "2026-09-28", [{ reps: 5, load: 77.5 }]);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
async function photoBytes(payload: Record<string, unknown>): Promise<Buffer> {
  const file = payload.photo as {
    toRaw(): Promise<Iterable<Uint8Array> | AsyncIterable<Uint8Array>>;
  };
  const raw = await file.toRaw();
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  const chunks: Uint8Array[] = [];
  for await (const c of raw) chunks.push(c);
  return Buffer.concat(chunks);
}

const botInfo = {
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
} as unknown as UserFromGetMe;

function setup() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  };
  const bot = createBot({
    db,
    now: () => new Date("2026-10-26T05:00:00Z"),
    token: "123:abc",
    botInfo,
    transformer,
  });
  const send = (text: string) =>
    bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 42, type: "private", first_name: "F" },
        from: { id: 42, is_bot: false, first_name: "F" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
      },
    });
  return { calls, send };
}

describe("/chart (real DB and renderer)", () => {
  it("/chart squat renders a photo with a caption", async () => {
    const { calls, send } = setup();
    await send("/chart squat");
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect(String(calls[0]?.payload.caption)).toContain("2 sessions");
    expect((await photoBytes(calls[0]?.payload ?? {})).subarray(0, 4).equals(PNG)).toBe(true);
  });

  it("/chart with an exercise that has no history answers with text", async () => {
    const { calls, send } = setup();
    await send("/chart hack squat");
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
    expect(String(calls[0]?.payload.text)).toContain("Not enough data");
  });

  it("/chart volume renders a real PNG photo", async () => {
    const { calls, send } = setup();
    await send("/chart volume");
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]?.payload.parse_mode).toBe("HTML");
    expect((await photoBytes(calls[0]?.payload ?? {})).subarray(0, 4).equals(PNG)).toBe(true);
  });

  it("/chart lists the seeded main lifts as buttons", async () => {
    const { calls, send } = setup();
    await send("/chart");
    const markup = calls[0]?.payload.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    const data = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain(`ch:${await exId(sql, "squat")}`);
    expect(data.at(-1)).toBe("ch:v");
  });
});
