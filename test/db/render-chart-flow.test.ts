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
import { NUMBER_GUARD_FALLBACK } from "../../src/bot/log-format.js";
import { connect, exId, MON, resetAndSeed } from "./logging-fixture.js";

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
const CHAT_OBJ = { id: 42, type: "private" as const, first_name: "F" };

function setup(script: ScriptedTurn[]) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  };
  const bot = createBot({
    db,
    now: () => MON,
    token: "123:abc",
    botInfo,
    transformer,
    ai: {
      model: createFakeModel(script),
      dailyTokenCap: 1_000_000,
      monthlyTokenCap: 10_000_000,
    },
  });
  const say = (body: string) =>
    bot.handleUpdate({
      update_id: 5000,
      message: {
        message_id: 1,
        date: 0,
        chat: CHAT_OBJ,
        from: { id: 42, is_bot: false, first_name: "F" },
        text: body,
      },
    });
  return { calls, say, methods: () => calls.map((c) => c.method) };
}

const chart = (input: unknown) => turn(toolUse("render_chart", input));

describe("render_chart in chat", () => {
  it("sends the reply, then the chart photo", async () => {
    const t = setup([
      chart({ metric: "load", exercise: "squat" }),
      turn(text("Up over 2 sessions.")),
    ]);
    await t.say("how is my squat going?");
    expect(t.methods()).toEqual(["sendMessage", "sendPhoto"]);
    expect(t.calls[0]?.payload.text).toBe("Up over 2 sessions.");
    expect(t.calls[1]?.payload.parse_mode).toBe("HTML");
    expect(String(t.calls[1]?.payload.caption)).toContain("2 sessions");
  });

  it("still sends the photo after the code fallback when the number guard rejects the reply", async () => {
    const t = setup([
      chart({ metric: "load", exercise: "squat" }),
      turn(text("Your e1RM went from 11 to 999 kg.")),
    ]);
    await t.say("how is my squat going?");
    expect(t.methods()).toEqual(["sendMessage", "sendPhoto"]);
    expect(String(t.calls[0]?.payload.text)).not.toContain("999");
    expect(t.calls[0]?.payload.text).not.toBe(NUMBER_GUARD_FALLBACK);
  });

  it("refuses a second chart in the same message", async () => {
    const t = setup([
      chart({ metric: "load", exercise: "squat" }),
      chart({ metric: "volume" }),
      turn(text("Done.")),
    ]);
    await t.say("charts please");
    expect(t.methods()).toEqual(["sendMessage", "sendPhoto"]);
  });

  it("sends no photo for an unknown exercise", async () => {
    const t = setup([
      chart({ metric: "load", exercise: "zzzzzz" }),
      turn(text("I don't know that exercise.")),
    ]);
    await t.say("chart zzzzzz");
    expect(t.methods()).toEqual(["sendMessage"]);
  });

  it("sends no photo when writes were staged", async () => {
    const t = setup([
      turn(
        toolUse("render_chart", { metric: "load", exercise: "squat" }),
        toolUse("log_sets", {
          exercise: { slug: "squat", said: "squat" },
          sets: { count: 3, reps: 8, load_kg: 60 },
          guessed_fields: [],
          needs_confirmation: false,
        }),
      ),
      turn(text("ok")),
    ]);
    await t.say("squat 3x8 60 and chart it");
    expect(t.methods()).not.toContain("sendPhoto");
  });
});
