/**
 * M5 WP5: the progression engine wired into the bot (display, logging links, new inputs, tools).
 * Real Postgres, scripted model, fake Telegram transport.
 */
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
import { checkNumbers } from "../../src/ai/number-guard.js";
import { createBot } from "../../src/bot/bot.js";
import { groupSnapshot, lastSessionRef } from "../../src/logging/groups.js";
import { createLoggingBackend } from "../../src/logging/resolve.js";
import {
  loadExerciseInfos,
  loadPlanEnv,
  loadSessionRecs,
} from "../../src/progression/load-history.js";
import { ensureSuggestions } from "../../src/progression/store.js";
import { connect, exId, MON, resetAndSeed, TUE } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const FRI = new Date("2026-10-02T08:00:00Z");
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
  await resetAndSeed(db, sql, { fridaySquat: true });
  await sql`update exercises set is_main_lift = true where slug in ('squat', 'hack_squat', 'bench_press', 'pull_up')`;
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

function setup(script: ScriptedTurn[] = []) {
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
    ai: { model, dailyTokenCap: 1_000_000, monthlyTokenCap: 10_000_000 },
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
  const texts = () => sent().map((c) => String(c.payload.text));
  const buttons = (c: Call | undefined): { text: string; data: string }[] =>
    (
      (c?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })
        ?.inline_keyboard ?? []
    )
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data }));
  const lastSent = () => sent().at(-1);
  const lastEdit = () => edits().at(-1);
  return { calls, model, say, tap, sent, edits, texts, buttons, lastSent, lastEdit };
}

const tool = (name: string, input: unknown) => turn(toolUse(name, input));
const nothing = turn(text(""));
const log = (slug: string, sets: unknown, extra: Record<string, unknown> = {}) => ({
  exercise: { slug, said: slug },
  sets,
  guessed_fields: [],
  needs_confirmation: false,
  ...extra,
});

async function history(
  slug: string,
  date: string,
  sets: { reps: number; load?: number; rir?: number; clean?: boolean; band?: string }[],
  opts: { hspuStep?: string; bw?: number } = {},
): Promise<number> {
  const exerciseId = await exId(sql, slug);
  const stepId = opts.hspuStep
    ? (await sql`select id from hspu_ladder where slug = ${opts.hspuStep}`)[0]?.id
    : null;
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, exercise_id, source, bw_kg, hspu_step_id)
    values (${date}, ${`${date}T08:00:00Z`}, ${exerciseId}, 'text', ${opts.bw ?? 70}, ${stepId})
    returning id`;
  for (const [i, s] of sets.entries()) {
    await sql`
      insert into log_entries (group_id, set_index, reps, load_kg, added_kg, band, rir, rir_plus, clean)
      values (${g?.id}, ${i + 1}, ${s.reps}, ${s.load ?? null}, ${s.load === undefined ? 0 : null},
        ${s.band ?? null}, ${s.rir ?? null}, false, ${s.clean ?? null})`;
  }
  return g?.id as number;
}

/** Three squat sessions before the plan: median e1RM 120 kg, so a Monday suggestion of 95 kg. */
async function squatHistory() {
  await history("squat", "2026-09-07", [{ reps: 5, load: 100, rir: 1 }]);
  await history("squat", "2026-09-14", [{ reps: 5, load: 100, rir: 1 }]);
  await history("squat", "2026-09-21", [{ reps: 8, load: 50, rir: 2 }]);
}

const squatSuggestion = async () =>
  (
    await sql`
      select s.* from suggestions s join exercises e on e.id = s.exercise_id
      where s.session_date = '2026-09-28' and e.slug = 'squat'`
  )[0];

describe("far-off check against the stored suggestion (SPEC 5.6d)", () => {
  it("asks when the load is far from the suggestion and says so", async () => {
    await squatHistory();
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 60 }, { rir: 2 })),
      nothing,
    ]);
    await t.say("squat 3x8 60 rir 2");
    const card = String(t.lastSent()?.payload.text);
    expect(card).toContain("Save this?");
    const sug = await squatSuggestion();
    expect(sug?.system_load).toBe("95.00");
    expect(card).toContain("far from the suggestion: 60 kg vs 95 kg suggested");
    expect(
      (await sql`select count(*)::int as n from log_groups where source <> 'import'`)[0]?.n,
    ).toBe(3);
  });

  it("falls back to the last session when there is no suggestion", async () => {
    // No bench history: no suggestion for bench, but last session (70 kg) exists via an import-less 1-set log.
    await history("bench_press", "2026-09-21", [{ reps: 5, load: 40 }]);
    const t = setup([
      tool("log_sets", log("bench_press", { count: 2, reps: 6, load_kg: 80 })),
      nothing,
    ]);
    await t.say("bench 2x6 80");
    const card = String(t.lastSent()?.payload.text);
    expect(card).toContain("far from last time: 80 kg vs 40 kg last time");
  });

  it("a load near the suggestion is written at once and linked to it", async () => {
    await squatHistory();
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 95 }, { rir: 2 })),
      nothing,
    ]);
    await t.say("squat 3x8 95 rir 2");
    expect(String(t.lastSent()?.payload.text)).toContain("✓ squat");
    const sug = await squatSuggestion();
    const [g] = await sql`
      select suggestion_id, readiness_level from log_groups where session_date = '2026-09-28' and source = 'text'
      order by id desc limit 1`;
    expect(g?.suggestion_id).toBe(sug?.id);
    expect(g?.readiness_level).toBe("GREEN");
    const [derived] =
      await sql`select level from readiness_logs where source = 'derived' and date = '2026-09-28'`;
    expect(derived?.level).toBe("GREEN");
  });
});

describe("readiness", () => {
  it("a chat signal before the first log moves today's level, and the log keeps it", async () => {
    await squatHistory();
    const t = setup([
      tool("log_readiness", { signal: "bad_sleep" }),
      nothing,
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 90 }, { rir: 2 })),
      nothing,
    ]);
    await t.say("slept badly");
    expect(String(t.lastSent()?.payload.text)).toContain("Noted: bad sleep");
    expect(t.buttons(t.lastSent()).map((b) => b.data)[0]).toMatch(/^uw:u:\d+:0$/);
    const [row] = await sql`select kind, source from readiness_logs where source = 'chat'`;
    expect(row).toMatchObject({ kind: "chat_bad_sleep", source: "chat" });
    // Not frozen yet: the first log (or /today after 05:00) freezes it from all signals.
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(0);

    await t.say("squat 3x8 90 rir 2");
    const [derived] = await sql`select level from readiness_logs where source = 'derived'`;
    expect(derived?.level).toBe("YELLOW");
    const [g] =
      await sql`select readiness_level from log_groups where source = 'text' and session_date = '2026-09-28' order by id desc limit 1`;
    expect(g?.readiness_level).toBe("YELLOW");
    const sug = await squatSuggestion();
    expect(sug?.readiness_level).toBe("YELLOW");
  });

  it("Undo removes the note and re-freezes the level", async () => {
    const t = setup([tool("log_readiness", { signal: "sore" }), nothing]);
    await t.say("/today");
    await t.say("legs are dead");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "YELLOW",
    );
    const undo = t.buttons(t.lastSent())[0]?.data as string;
    await t.tap(undo);
    expect(
      (await sql`select count(*)::int as n from readiness_logs where source = 'chat'`)[0]?.n,
    ).toBe(0);
    const [derived] = await sql`select level from readiness_logs where source = 'derived'`;
    expect(derived?.level).toBe("GREEN");
    // a second tap finds nothing
    await t.tap(undo);
    expect(String(t.lastEdit()?.payload.text ?? "")).not.toContain("Undone");
  });

  it("'good' is a strong-button note that cancels chat signals of the day", async () => {
    const t = setup([
      tool("log_readiness", { signal: "exhausted" }),
      nothing,
      tool("log_readiness", { signal: "good" }),
      nothing,
    ]);
    await t.say("/today");
    await t.say("wiped out");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "YELLOW",
    );
    await t.say("actually I feel great");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "GREEN",
    );
  });

  it("/readiness: a tap before the first log re-freezes, after it the level stays", async () => {
    await squatHistory();
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 90 }, { rir: 2 })),
      nothing,
    ]);
    await t.say("/today");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "GREEN",
    );

    await t.say("/readiness");
    const buttons = t.buttons(t.lastSent()).map((b) => b.data);
    expect(buttons).toEqual(["rd:t", "rd:o", "rd:s"]);
    await t.tap("rd:t");
    expect(String(t.lastEdit()?.payload.text)).toBe("Noted: 😴");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "YELLOW",
    );
    // the adjusted session follows
    expect(String(t.lastSent()?.payload.text)).toContain("🟡 YELLOW day (tired)");

    await t.say("squat 3x8 90 rir 2");
    expect(
      (
        await sql`select readiness_level from log_groups where source = 'text' and session_date = '2026-09-28'`
      )[0]?.readiness_level,
    ).toBe("YELLOW");

    // after the first log: a second 😴 would make it RED if it were recomputed, but the level is frozen
    await sql`insert into readiness_logs (date, at, kind, source) values ('2026-09-28', ${clock.toISOString()}, 'chat_sore', 'chat')`;
    await t.tap("rd:t");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "YELLOW",
    );
    expect(t.texts().at(-2)).toContain("today stays YELLOW");
  });

  it("🙂 adds nothing", async () => {
    const t = setup();
    await t.say("/readiness");
    await t.tap("rd:o");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "GREEN",
    );
    expect((await sql`select kind from readiness_logs where source = 'button'`)[0]?.kind).toBe(
      "button_ok",
    );
  });
});

describe("/bw and log_bodyweight", () => {
  it("/bw 78,5 upserts today's bodyweight with an Undo that restores the old value", async () => {
    const t = setup();
    await t.say("/bw 78,5");
    expect(String(t.lastSent()?.payload.text)).toBe("✓ Bodyweight 78.5 kg");
    expect((await sql`select kg from bodyweight_logs where date = '2026-09-28'`)[0]?.kg).toBe(
      "78.50",
    );
    const undo = t.buttons(t.lastSent())[0]?.data as string;
    expect(undo).toMatch(/^uw:u:\d+:0$/);
    await t.tap(undo);
    expect((await sql`select kg from bodyweight_logs where date = '2026-09-28'`)[0]?.kg).toBe(
      "70.00",
    );
    expect(String(t.lastEdit()?.payload.text)).toBe("Bodyweight back to 70 kg.");
  });

  it("refuses a missing or silly number", async () => {
    const t = setup();
    await t.say("/bw");
    await t.say("/bw abc");
    await t.say("/bw 7");
    expect(t.texts()).toEqual([
      "Send your bodyweight in kg, for example: /bw 78.5",
      "Send your bodyweight in kg, for example: /bw 78.5",
      "Send your bodyweight in kg, for example: /bw 78.5",
    ]);
    expect((await sql`select kg from bodyweight_logs`)[0]?.kg).toBe("70.00");
  });

  it("the same update delivered twice writes once", async () => {
    const t = setup();
    await t.say("/bw 80", 5000);
    await t.say("/bw 80", 5000);
    expect(
      (await sql`select count(*)::int as n from write_ledger where source_key = 'u:5000'`)[0]?.n,
    ).toBe(1);
  });

  it("chat: log_bodyweight saves directly with an Undo", async () => {
    const t = setup([tool("log_bodyweight", { kg: 78.5 }), nothing]);
    await t.say("I'm 78.5 kg today");
    expect(String(t.lastSent()?.payload.text)).toBe("✓ Bodyweight 78.5 kg");
    expect(
      (await sql`select kg, source from bodyweight_logs where date = '2026-09-28'`)[0],
    ).toMatchObject({
      kg: "78.50",
      source: "bot",
    });
  });
});

describe("/class and the Friday view", () => {
  it("toggles, saves on Thursday's date and reduces Friday's squat", async () => {
    clock = FRI;
    const t = setup();
    await t.say("/today");
    expect(String(t.lastSent()?.payload.text)).toContain("How was Thursday's class? /class");

    await t.say("/class");
    const card = t.lastSent();
    expect(String(card?.payload.text)).toContain("Thursday class (Thu 1 Oct)");
    expect(t.buttons(card).map((b) => b.data)).toEqual([
      "cg:1:20261001",
      "cg:2:20261001",
      "cg:4:20261001",
      "cg:0:20261001",
      "cg:0:20261001:ok",
    ]);

    await t.tap("cg:4:20261001");
    const toggled = t.lastEdit();
    expect(String(toggled?.payload.text)).toContain("Selected: legs");
    expect(t.buttons(toggled).map((b) => b.text)).toContain("✓ Legs");
    expect(t.buttons(toggled).map((b) => b.data)).toContain("cg:4:20261001:ok");
    // nothing is saved before Save
    expect((await sql`select count(*)::int as n from class_logs`)[0]?.n).toBe(0);

    await t.tap("cg:4:20261001:ok");
    const [row] = await sql`select date::text as date, heavy_groups, source from class_logs`;
    expect(row).toMatchObject({ date: "2026-10-01", heavy_groups: ["legs"], source: "bot" });
    expect(String(t.lastEdit()?.payload.text)).toBe("✓ Thursday class: heavy LEGS");

    await t.say("/today");
    const friday = String(t.lastSent()?.payload.text);
    expect(friday).toContain("Thursday class: heavy LEGS");
    expect(friday).toContain("reduced to 2 × 4 (heavy legs Thursday) — or skip");
    expect(friday).not.toContain("How was Thursday's class?");

    // Undo removes the report: Friday asks again
    const undo = t.buttons(t.lastEdit()).map((b) => b.data)[0] as string;
    await t.tap(undo);
    expect((await sql`select count(*)::int as n from class_logs`)[0]?.n).toBe(0);
    await t.say("/today");
    expect(String(t.lastSent()?.payload.text)).toContain("How was Thursday's class? /class");
  });

  it("'Not heavy' saves an empty report and Friday stays as written", async () => {
    clock = FRI;
    const t = setup();
    await t.say("/class");
    await t.tap("cg:1:20261001");
    await t.tap("cg:0:20261001");
    await t.tap("cg:0:20261001:ok");
    expect((await sql`select heavy_groups from class_logs`)[0]?.heavy_groups).toEqual([]);
    await t.say("/today");
    const out = String(t.lastSent()?.payload.text);
    expect(out).toContain("Thursday class: not heavy");
    expect(out).not.toContain("reduced to");
  });

  it("chat: log_class keeps one row per Thursday", async () => {
    clock = FRI;
    const t = setup([
      tool("log_class", { heavy_groups: ["legs"] }),
      nothing,
      tool("log_class", { heavy_groups: ["pull", "push"] }),
      nothing,
    ]);
    await t.say("class was heavy on legs");
    await t.say("no, pull and push");
    const rows = await sql`select date::text as date, heavy_groups from class_logs`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-10-01", heavy_groups: ["pull", "push"] });
  });

  it("on a Monday the report goes to the last Thursday", async () => {
    const t = setup();
    await t.say("/class");
    await t.tap("cg:2:20260924:ok");
    expect((await sql`select date::text as date from class_logs`)[0]?.date).toBe("2026-09-24");
  });
});

describe("review fixes", () => {
  it("/class Save lands on the card's Thursday even when tapped days later", async () => {
    clock = FRI;
    const t = setup();
    await t.say("/class");
    clock = new Date("2026-10-05T08:00:00Z"); // next Monday
    await t.tap("cg:4:20261001:ok");
    expect((await sql`select date::text as date from class_logs`)[0]?.date).toBe("2026-10-01");
    // a date that is not a Thursday is refused
    await t.tap("cg:4:20261002:ok");
    expect(await sql`select id from class_logs`).toHaveLength(1);
  });

  it("a /readiness tap delivered twice writes one row", async () => {
    const t = setup();
    await t.say("/readiness");
    await t.tap("rd:t", 1, 7000);
    await t.tap("rd:t", 1, 7000);
    expect(await sql`select id from readiness_logs where source = 'button'`).toHaveLength(1);
  });

  it("before 05:00 a tap records the signal and freezes nothing; /today at 10:00 then does", async () => {
    clock = new Date("2026-09-28T01:30:00Z"); // 03:30 Rome, still Monday's training day
    const t = setup();
    await t.say("/readiness");
    await t.tap("rd:t");
    expect(await sql`select id from readiness_logs where source = 'button'`).toHaveLength(1);
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(0);
    clock = MON;
    await t.say("/today");
    expect((await sql`select level from readiness_logs where source = 'derived'`)[0]?.level).toBe(
      "YELLOW",
    );
  });

  it("a make-up takes its own day's level, not the day it is logged", async () => {
    await sql`insert into readiness_logs (date, at, kind, source, level) values
      ('2026-09-28', ${MON.toISOString()}, 'button_ok', 'derived', 'RED'),
      ('2026-09-29', ${TUE.toISOString()}, 'button_ok', 'derived', 'GREEN')`;
    clock = TUE;
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 60 }, { rir: 2, day: "mon" })),
      nothing,
    ]);
    await t.say("monday's squat 3x8 60");
    const ok = t.buttons(t.lastSent())[0]?.data as string;
    await t.tap(ok);
    expect(
      (await sql`select readiness_level from log_groups where session_date = '2026-09-28'`)[0]
        ?.readiness_level,
    ).toBe("RED");
  });

  it("a make-up for a day with no frozen level gets none, and freezes nothing for today", async () => {
    clock = TUE;
    const t = setup([
      tool("log_sets", log("squat", { count: 3, reps: 8, load_kg: 60 }, { rir: 2, day: "mon" })),
      nothing,
    ]);
    await t.say("monday's squat 3x8 60");
    await t.tap(t.buttons(t.lastSent())[0]?.data as string);
    expect(
      (await sql`select readiness_level from log_groups where session_date = '2026-09-28'`)[0]
        ?.readiness_level,
    ).toBeNull();
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(0);
  });

  it("the band question is asked once for two groups of one message", async () => {
    const t = setup([
      turn(
        toolUse(
          "log_sets",
          log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 }),
        ),
        toolUse(
          "log_sets",
          log("pull_up", { count: 2, reps: 4, band: "red" }, { clean: true, rir: 1 }),
        ),
      ),
      nothing,
    ]);
    await t.say("two pull-up blocks with the red band");
    await t.tap(t.buttons(t.lastSent())[0]?.data as string);
    expect(t.texts().filter((x) => x.startsWith("How many kg is the red band"))).toHaveLength(1);
  });

  it("an edit to a new unmapped colour asks for it; one back to a known colour does not", async () => {
    await sql`update equipment set bands = ${JSON.stringify({ red: 15 })}::jsonb where slug = 'pullup'`;
    const t = setup([
      tool("log_sets", log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
      tool("edit_last_entry", {
        changes: { band: "purple" },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      nothing,
      tool("edit_last_entry", {
        changes: { reps: 6 },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      nothing,
    ]);
    await t.say("pull-ups 2x5 red band");
    await t.say("no, purple band");
    expect(t.texts().filter((x) => x.startsWith("How many kg is the purple band"))).toHaveLength(1);
    await t.say("reps 6");
    expect(t.texts().filter((x) => x.startsWith("How many kg"))).toHaveLength(1);
  });

  it("set_band_kg refreshes the derived state", async () => {
    await sql`delete from user_state`;
    const t = setup([tool("set_band_kg", { colour: "red", kg: 15 }), nothing]);
    await t.say("red band is 15 kg");
    await t.tap(t.buttons(t.lastSent())[0]?.data as string);
    expect(await sql`select id from user_state where id = 1`).toHaveLength(1);
  });

  it("a band remap changes what logging reads, like the engine", async () => {
    await sql`update equipment set bands = ${JSON.stringify({ red: 15 })}::jsonb where slug = 'pullup'`;
    const t = setup([
      tool("log_sets", log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
    ]);
    await t.say("pull-ups 2x5 red band");
    const pullId = await exId(sql, "pull_up");
    const ref = () => lastSessionRef(db, { id: pullId, type: "bodyweight_plus" }, "2026-10-05");
    expect((await ref())?.maxSystemLoad).toBe(55); // bw 70 - 15
    await sql`update equipment set bands = ${JSON.stringify({ red: 20 })}::jsonb where slug = 'pullup'`;
    expect((await ref())?.maxSystemLoad).toBe(50);
    const [g] = await sql`select id from log_groups where source = 'text'`;
    expect((await groupSnapshot(db, g?.id as number))?.entries[0]?.assistKg).toBe(20);
    // the engine reads the same kg
    const env = await loadPlanEnv(db);
    const infos = await loadExerciseInfos(db, [pullId]);
    const recs = await loadSessionRecs(db, env as NonNullable<typeof env>, infos, [pullId], null);
    expect(recs.get(pullId)?.[0]?.sets[0]?.assistKg).toBe(20);
    // unmapped then mapped: no kg first, the new kg after
    await sql`update equipment set bands = '{}'::jsonb where slug = 'pullup'`;
    expect((await groupSnapshot(db, g?.id as number))?.entries[0]?.assistKg).toBeNull();
    expect((await ref())?.maxSystemLoad).toBeNull();
    await sql`update equipment set bands = ${JSON.stringify({ red: 12.5 })}::jsonb where slug = 'pullup'`;
    expect((await ref())?.maxSystemLoad).toBe(57.5);
  });
});

describe("round-2 fixes", () => {
  it("the ledger records the real /readiness button", async () => {
    const t = setup();
    await t.say("/readiness");
    await t.tap("rd:t", 1, 8001);
    await t.tap("rd:o", 1, 8002);
    await t.tap("rd:s", 1, 8003);
    const rows = await sql`select source_key, result from write_ledger order by source_key`;
    expect(rows.map((r) => [r.source_key, r.result.signal])).toEqual([
      ["u:8001", "tired"],
      ["u:8002", "ok"],
      ["u:8003", "strong"],
    ]);
    expect(
      (await sql`select kind from readiness_logs where source = 'button' order by id`).map(
        (r) => r.kind,
      ),
    ).toEqual(["button_tired", "button_ok", "button_strong"]);
  });

  it("get_exercise_history and /history read band kg like the engine after a remap", async () => {
    await sql`update equipment set bands = ${JSON.stringify({ red: 15 })}::jsonb where slug = 'pullup'`;
    const t = setup([
      tool("log_sets", log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
    ]);
    await t.say("pull-ups 2x5 red band");
    const facts = async () =>
      (
        (
          await createLoggingBackend(db, MON).getExerciseHistory({
            exercise: { slug: "pull_up", said: "pull_up" },
          })
        ).facts as { sessions: { sets: { assistKg: number | null }[] }[] }
      ).sessions[0]?.sets.map((x) => x.assistKg);
    expect(await facts()).toEqual([15, 15]);
    await sql`update equipment set bands = ${JSON.stringify({ red: 20 })}::jsonb where slug = 'pullup'`;
    expect(await facts()).toEqual([20, 20]);
    await sql`update equipment set bands = '{}'::jsonb where slug = 'pullup'`;
    expect(await facts()).toEqual([null, null]);
    await t.say("/history pull_up");
    expect(String(t.lastSent()?.payload.text)).toContain("red band");
  });
});

describe("band sets", () => {
  it("stores the colour, asks the kg once, and set_band_kg writes the equipment after a tap", async () => {
    const t = setup([
      tool("log_sets", log("pull_up", { count: 3, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
      tool("log_sets", log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
      tool("set_band_kg", { colour: "red", kg: 15 }),
      nothing,
    ]);
    await t.say("pull-ups 3x5 red band");
    const entries = await sql`select band, assist_kg, note from log_entries order by id`;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ band: "red", assist_kg: null, note: null });
    expect(t.texts().at(-1)).toBe('How many kg is the red band? Send e.g. "red band 15 kg".');
    const asked = t.texts().filter((x) => x.startsWith("How many kg")).length;
    expect(asked).toBe(1);

    await t.say("2x5 red band again");
    expect(t.texts().filter((x) => x.startsWith("How many kg"))).toHaveLength(1);

    await t.say("red band is 15 kg");
    const card = t.lastSent();
    expect(String(card?.payload.text)).toContain("Set the red band to 15 kg of assistance");
    expect(String(card?.payload.text)).toContain("this changes your equipment");
    // equipment untouched until ✅
    expect((await sql`select bands from equipment where slug = 'pullup'`)[0]?.bands).toEqual({});
    const ok = t.buttons(card)[0]?.data as string;
    await t.tap(ok);
    expect((await sql`select bands from equipment where slug = 'pullup'`)[0]?.bands).toEqual({
      red: 15,
    });
    expect(t.texts().at(-1)).toBe("Saved: red band = 15 kg");
  });

  it("a band mapped in equipment fills the assistance kg and needs no question", async () => {
    await sql`update equipment set bands = ${JSON.stringify({ red: 15 })}::jsonb where slug = 'pullup'`;
    const t = setup([
      tool(
        "log_sets",
        log("pull_up", { count: 3, reps: 5, band: "Red band" }, { clean: true, rir: 1 }),
      ),
      nothing,
    ]);
    await t.say("pull-ups 3x5 red band");
    expect((await sql`select band, assist_kg from log_entries`)[0]).toMatchObject({
      band: "red",
      assist_kg: "15.00",
    });
    expect(t.texts().some((x) => x.startsWith("How many kg"))).toBe(false);
  });

  it("an edit to a band keeps the colour column in step", async () => {
    await sql`update equipment set bands = ${JSON.stringify({ red: 15, blue: 25 })}::jsonb where slug = 'pullup'`;
    const t = setup([
      tool("log_sets", log("pull_up", { count: 2, reps: 5, band: "red" }, { clean: true, rir: 1 })),
      nothing,
      tool("edit_last_entry", {
        changes: { band: "blue" },
        guessed_fields: [],
        needs_confirmation: false,
      }),
      nothing,
    ]);
    await t.say("pull-ups 2x5 red band");
    await t.say("no, blue band");
    const rows = await sql`select band, assist_kg from log_entries order by set_index`;
    expect(rows.map((r) => [r.band, r.assist_kg])).toEqual([
      ["blue", "25.00"],
      ["blue", "25.00"],
    ]);
  });
});

describe("derived state is refreshed with every write", () => {
  it("a clean bodyweight set of 6 opens the gate and Undo closes it", async () => {
    await history("pull_up", "2026-09-21", [{ reps: 4, clean: true, rir: 1 }]);
    const t = setup([
      tool("log_sets", log("pull_up", { count: 1, reps: 6 }, { clean: true, rir: 1 })),
      nothing,
    ]);
    await t.say("pull-up 6 clean");
    expect(
      (await sql`select pullup_gate_open from user_state where id = 1`)[0]?.pullup_gate_open,
    ).toBe(true);
    // the engine agrees: next Monday's weighted pull-up is in weighted mode
    const pullMode = async () => {
      const r = await ensureSuggestions(db, "2026-10-05");
      return r?.session.items.find((i) => i.target.planName === "Weighted pull-up")?.pullup?.mode;
    };
    expect(await pullMode()).toBe("weighted");
    const undo = t.buttons(t.lastSent()).find((b) => b.data.startsWith("ug:"))?.data as string;
    await t.tap(undo);
    expect(
      (await sql`select pullup_gate_open from user_state where id = 1`)[0]?.pullup_gate_open,
    ).toBe(false);
    expect(await pullMode()).not.toBe("weighted");
  });
});

describe("HSPU advance proposal", () => {
  async function twoCleanSessions() {
    for (const date of ["2026-09-15", "2026-09-22"]) {
      await history(
        "hspu",
        date,
        [
          { reps: 3, clean: true, rir: 2 },
          { reps: 3, clean: true, rir: 2 },
          { reps: 3, clean: true, rir: 2 },
        ],
        { hspuStep: "hspu_negative" },
      );
    }
  }

  it("proposes once, accept moves the step for /today and for the next log", async () => {
    clock = TUE;
    await twoCleanSessions();
    const t = setup([
      tool("log_sets", log("hspu", { count: 3, reps: 3 }, { clean: true, rir: 2 })),
      nothing,
    ]);
    const proposed = await ensureSuggestions(db, "2026-09-29");
    expect(
      proposed?.session.items.find((i) => i.target.planName === "HSPU progression")?.hspuAdvance,
    ).toEqual({ fromStepOrder: 1, toStepOrder: 2 });
    await t.say("/today");
    const card = t.lastSent();
    expect(String(card?.payload.text)).toBe(
      "You hit the target on 2 clean HSPU sessions at hspu_negative. Move to partial_rom_wall_hspu?",
    );
    const [ok, no] = t.buttons(card).map((b) => b.data) as [string, string];
    expect(ok).toMatch(/^pr:\d+:ok$/);
    expect(no).toMatch(/^pr:\d+:no$/);
    expect((await sql`select status from proposals`).map((r) => r.status)).toEqual(["open"]);

    // asking again does not repeat the card
    const before = t.sent().length;
    await t.say("/today");
    expect(t.sent().length).toBe(before + 1);

    await t.tap(ok);
    expect(String(t.lastEdit()?.payload.text)).toBe("Moved HSPU to partial_rom_wall_hspu ✓");
    expect((await sql`select status from proposals`).map((r) => r.status)).toEqual(["accepted"]);
    const [state] = await sql`
      select l.slug from user_state u join hspu_ladder l on l.id = u.hspu_step_id`;
    expect(state?.slug).toBe("partial_rom_wall_hspu");
    // the engine itself now sees step 2 and proposes nothing more
    const eng = await ensureSuggestions(db, "2026-09-29");
    const hspuItem = eng?.session.items.find((i) => i.target.planName === "HSPU progression");
    expect(hspuItem?.hspuAdvance).toBeNull();
    const hspuId = await exId(sql, "hspu");
    expect(eng?.input.history[hspuId]?.[0]?.hspuStepOrder).toBe(2);

    // a second tap is harmless
    await t.tap(ok);

    await t.say("/today");
    expect(String(t.sent().at(-1)?.payload.text)).toContain("<b>HSPU — partial_rom_wall_hspu</b>");
    expect(t.texts().filter((x) => x.startsWith("You hit the target"))).toHaveLength(1);

    // the next HSPU log is on the new step
    await t.say("hspu 3x3");
    const [g] = await sql`
      select l.slug from log_groups g join hspu_ladder l on l.id = g.hspu_step_id
      where g.source = 'text' order by g.id desc limit 1`;
    expect(g?.slug).toBe("partial_rom_wall_hspu");
  });

  it("decline keeps the step and the card does not come back", async () => {
    clock = TUE;
    await twoCleanSessions();
    const t = setup();
    await t.say("/today");
    const no = t.buttons(t.lastSent())[1]?.data as string;
    await t.tap(no);
    expect(String(t.lastEdit()?.payload.text)).toBe("OK, staying on hspu_negative.");
    expect((await sql`select status from proposals`).map((r) => r.status)).toEqual(["declined"]);
    await t.say("/today");
    await t.say("/today");
    expect(t.texts().filter((x) => x.startsWith("You hit the target"))).toHaveLength(1);
    expect((await sql`select count(*)::int as n from proposals`)[0]?.n).toBe(1);
  });
});

describe("/today, /session, /next, /short", () => {
  it("/today shows the suggestion with its label and stores it", async () => {
    await squatHistory();
    const t = setup();
    await t.say("/today");
    const out = String(t.lastSent()?.payload.text);
    expect(out).toContain("<b>squat or hack_squat</b> — 3 × 6–8 · RIR 1–2");
    expect(out).toContain("squat: 95 kg");
    expect(out).toContain("hack_squat");
    expect(
      await sql`select id from suggestions where session_date = '2026-09-28'`,
    ).not.toHaveLength(0);
  });

  it("before 05:00 /today previews and does not freeze", async () => {
    clock = new Date("2026-09-28T01:30:00Z"); // 03:30 Rome: still Monday's training day
    const t = setup();
    await t.say("/today");
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(0);
    clock = MON;
    await t.say("/today");
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(1);
  });

  it("/session for a past date shows what was stored and never freezes", async () => {
    await squatHistory();
    const t = setup();
    await t.say("/today");
    clock = TUE;
    const derivedBefore = await sql`select id from readiness_logs where source = 'derived'`;
    await t.say("/session mon");
    const out = String(t.lastSent()?.payload.text);
    expect(out).toContain("squat: 95 kg");
    expect(await sql`select id from readiness_logs where source = 'derived'`).toHaveLength(
      derivedBefore.length,
    );
    // a day with nothing stored shows the plain plan
    await t.say("/session 2026-09-14");
    expect(String(t.lastSent()?.payload.text)).not.toContain("kg");
  });

  it("/next shows the next item with its load", async () => {
    await squatHistory();
    const t = setup();
    await t.say("/next");
    expect(String(t.lastSent()?.payload.text)).toContain("Next up");
  });

  it("/short flags Medium items and keeps Low out, without touching the stored suggestions", async () => {
    await sql`update planned_items set priority = 'Low' where plan_name = 'Lateral raise'`;
    await sql`update planned_items set priority = 'Medium' where plan_name = 'Cable row'`;
    const t = setup();
    await t.say("/short");
    const out = String(t.lastSent()?.payload.text);
    expect(out).toContain("· short");
    expect(out).not.toContain("<b>lateral_raise</b>");
    expect(out).toContain("Dropped today: lateral_raise");
    expect(out).toMatch(/cable_row<\/b>.*\(optional\)/);
  });

  it("weekends and before the plan start are unchanged", async () => {
    clock = new Date("2026-10-03T08:00:00Z");
    const t = setup();
    await t.say("/today");
    expect(String(t.lastSent()?.payload.text)).toContain("Rest day");
    clock = new Date("2026-09-20T08:00:00Z");
    await t.say("/today");
    expect(String(t.lastSent()?.payload.text)).toContain("The plan starts on");
  });
});

describe("read tools carry the suggestions", () => {
  it("get_session has formatted loads, labels and the level; the number guard accepts them", async () => {
    await squatHistory();
    const backend = createLoggingBackend(db, MON);
    const r = await backend.getSession({});
    const f = r.facts as {
      readiness: { level: string };
      items: {
        name: string;
        suggestions: {
          exercise: string;
          load: string | null;
          sets_reps: string | null;
          labels: string[];
        }[];
      }[];
    };
    expect(f.readiness.level).toBe("GREEN");
    const squat = f.items.find((i) => i.name === "Squat / hack squat");
    expect(squat?.suggestions[0]).toMatchObject({
      exercise: "squat",
      load: "95 kg",
      sets_reps: "3 x 6–8",
      labels: [],
    });
    const content = JSON.stringify(r.facts);
    expect(checkNumbers("Squat 3 x 6-8 at 95 kg.", [content])).toEqual({ ok: true });
    const bad = checkNumbers("Squat at 97.5 kg.", [content]);
    expect(bad.ok).toBe(false);
  });

  it("an item without history says what to do instead of inventing a load", async () => {
    const backend = createLoggingBackend(db, MON);
    const f = (await backend.getSession({})).facts as {
      items: { name: string; suggestions: { load: string | null; ask: string | null }[] }[];
    };
    const squat = f.items.find((i) => i.name === "Squat / hack squat");
    expect(squat?.suggestions.map((s) => [s.load, s.ask])).toEqual([
      [null, "baseline — tell me your weight"],
      [null, "baseline — tell me your weight"],
    ]);
  });

  it("a future day has no suggestions", async () => {
    await squatHistory();
    const backend = createLoggingBackend(db, MON);
    const r = await backend.getSession({ day: "tue" });
    expect((r.facts as { suggestions_note: string }).suggestions_note).toBe(
      "No suggested loads for a future day.",
    );
  });

  it("get_exercise_history has the current e1RM, an estimate while one session stands behind it", async () => {
    await history("bench_press", "2026-09-21", [{ reps: 8, load: 60, rir: 2 }]);
    const backend = createLoggingBackend(db, MON);
    const f = (await backend.getExerciseHistory({ exercise: { said: "bench press" } })).facts as {
      current_e1rm: { value: string; label: string | null } | null;
    };
    expect(f.current_e1rm).toEqual({ value: "80 kg", label: "estimate" });
  });

  it("the written prompt says suggestions come only from get_session", async () => {
    const { buildStaticText } = await import("../../src/ai/prompt.js");
    const text = buildStaticText({ catalog: [], hspuLadder: [] });
    expect(text).not.toContain("not available yet");
    expect(text).toContain("Suggested loads come ONLY from the get_session result");
  });
});
