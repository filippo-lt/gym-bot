import type { Transformer } from "grammy";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../../src/bot/bot.js";
import { MORNING_GREETING, renderTodayText } from "../../src/bot/morning.js";
import { morningJob } from "../../src/jobs/morning.js";
import { runDueJobs } from "../../src/jobs/runner.js";
import { connect, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql, { fridaySquat: true });
  await sql`truncate table job_runs restart identity`;
  // The fixture plan has weeks 1-3: shift the start so 26-30 Oct is week 3.
  await sql`update plans set weeks = 12, start_date = '2026-10-12'`;
  await sql`update plan_weeks set start_date = (date '2026-10-12' + (week - 1) * 7)`;
});

const botInfo = {
  id: 1,
  is_bot: true as const,
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

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

async function tap(now: Date, data: string, updateId: number): Promise<Call[]> {
  const calls: Call[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 42, type: "private" }, text: "" },
    } as never;
  };
  const bot = createBot({ db, now: () => now, token: "123:abc", botInfo, transformer });
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      chat_instance: "x",
      from: { id: 42, is_bot: false, first_name: "F" },
      data,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private", first_name: "F" },
        text: "old",
      },
    },
  } as never);
  return calls;
}

const TUE = "2026-10-27";
const derived = async () =>
  (
    await sql`select level from readiness_logs where date = ${TUE} and source = 'derived' order by id desc limit 1`
  )[0]?.level;
const edits = (c: Call[]) => c.filter((x) => x.method === "editMessageText");
const sends = (c: Call[]) => c.filter((x) => x.method === "sendMessage");

async function morning(): Promise<void> {
  await runDueJobs({ db, now: new Date("2026-10-27T05:00:00Z"), send: async () => {} }, [
    morningJob,
  ]);
}

describe("morning readiness tap", () => {
  it("before any log: edits the message in place, re-freezes, no second session", async () => {
    await morning();
    expect(await derived()).toBe("GREEN");
    const calls = await tap(new Date("2026-10-27T05:10:00Z"), "rd:t:m:20261027", 100);
    expect(edits(calls)).toHaveLength(1);
    const text = String(edits(calls)[0]?.payload.text);
    expect(text).toContain(MORNING_GREETING);
    expect(text).toContain("Noted: 😴");
    expect(text).not.toContain("Readiness:");
    expect(text).not.toContain("counts for tomorrow");
    expect(text).toContain((await renderTodayText(db, TUE, new Date("2026-10-27T05:10:00Z"))).text);
    expect(edits(calls)[0]?.payload.reply_markup).toBeUndefined();
    expect(sends(calls)).toHaveLength(0);
    expect(await derived()).toBe("YELLOW");
  });

  it("after a log: edits, replies that today stays, level unchanged", async () => {
    await morning();
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source)
      select ${TUE}::date, now(), id, 'text' from exercises limit 1`;
    const calls = await tap(new Date("2026-10-27T05:10:00Z"), "rd:t:m:20261027", 101);
    expect(edits(calls)).toHaveLength(1);
    expect(String(edits(calls)[0]?.payload.text)).toContain("Noted: 😴 · counts for tomorrow");
    const replies = sends(calls).map((c) => String(c.payload.text));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("You already started today, so today stays GREEN.");
    expect(await derived()).toBe("GREEN");
  });

  it("another day's button: answers, writes nothing", async () => {
    const calls = await tap(new Date("2026-10-27T05:10:00Z"), "rd:t:m:20261026", 102);
    const answer = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer?.payload.text).toBe("That button is from another day.");
    expect(edits(calls)).toHaveLength(0);
    expect(sends(calls)).toHaveLength(0);
    expect((await sql`select 1 from readiness_logs`).length).toBe(0);
  });

  it("old rd:t tap still edits to Noted and sends today", async () => {
    const calls = await tap(new Date("2026-10-27T05:10:00Z"), "rd:t", 103);
    expect(String(edits(calls)[0]?.payload.text)).toBe("Noted: 😴");
    expect(sends(calls)).toHaveLength(1);
  });
});

describe("class Save follow-up", () => {
  const save = "cg:0:20261029:ok";
  it("on the Friday after: edit + the Friday session", async () => {
    const calls = await tap(new Date("2026-10-30T05:10:00Z"), save, 110);
    expect(edits(calls)).toHaveLength(1);
    expect(sends(calls)).toHaveLength(1);
    expect(String(sends(calls)[0]?.payload.text)).toContain("Fri 30 Oct");
    expect((await sql`select 1 from class_logs where date = '2026-10-29'`).length).toBe(1);
  });

  it("on the Thursday evening: no session", async () => {
    const calls = await tap(new Date("2026-10-29T20:30:00Z"), save, 111);
    expect(edits(calls)).toHaveLength(1);
    expect(sends(calls)).toHaveLength(0);
  });
});
