import type { Transformer } from "grammy";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../../src/bot/bot.js";
import { formatFinished } from "../../src/bot/format.js";
import { READINESS_QUESTION } from "../../src/bot/inputs-flow.js";
import type { Message } from "../../src/bot/log-format.js";
import { MORNING_GREETING, renderTodayText } from "../../src/bot/morning.js";
import { CLASS_QUESTION, classQuestionJob } from "../../src/jobs/class-question.js";
import { morningJob } from "../../src/jobs/morning.js";
import { type Job, type JobContext, runDueJobs } from "../../src/jobs/runner.js";
import { connect, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`truncate table job_runs restart identity`;
  // The fixture plan is 3 weeks; the dates below fall in week 4-5.
  await sql`update plans set weeks = 12`;
});

const THU = "2026-10-22";
const sent: Message[] = [];
const ctxAt = (iso: string): JobContext => ({
  db,
  now: new Date(iso),
  send: async (m) => {
    sent.push(m);
  },
  sendFile: async () => {},
});
const tick = (iso: string) => runDueJobs(ctxAt(iso), [classQuestionJob]);
beforeEach(() => {
  sent.length = 0;
});

describe("class question job", () => {
  it("fires Thu 22 Oct 2026 21:00 Rome", async () => {
    const r = await tick("2026-10-22T19:00:00Z");
    expect(r).toEqual([{ job: "class_question", date: THU, outcome: "sent" }]);
    const rows = await sql`select status, done_at from job_runs`;
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.done_at).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("How did class go?");
    expect(sent[0]?.keyboard.flat().some((b) => b.data.startsWith("cg:"))).toBe(true);
  });

  it("not due at 20:45 or 23:00 Rome, nor on Wednesday", async () => {
    expect(await tick("2026-10-22T18:45:00Z")).toEqual([]);
    expect(await tick("2026-10-22T21:00:00Z")).toEqual([]);
    expect(await tick("2026-10-21T19:00:00Z")).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("DST: Thu 29 Oct 2026 21:00 Rome (20:00Z) fires; 19:00Z does not", async () => {
    expect(await tick("2026-10-29T19:00:00Z")).toEqual([]);
    const r = await tick("2026-10-29T20:00:00Z");
    expect(r[0]?.outcome).toBe("sent");
  });

  it("second tick in the window does not resend", async () => {
    await tick("2026-10-22T19:00:00Z");
    const r = await tick("2026-10-22T19:15:00Z");
    expect(r[0]?.outcome).toBe("busy");
    expect(sent).toHaveLength(1);
  });

  it("stale claim: 3 min is busy, 6 min is re-claimed once", async () => {
    await sql`insert into job_runs (job, date, status, claimed_at) values ('class_question', ${THU}, 'claimed', '2026-10-22T18:57:00Z')`;
    expect((await tick("2026-10-22T19:00:00Z"))[0]?.outcome).toBe("busy");
    expect(sent).toHaveLength(0);
    await sql`update job_runs set claimed_at = '2026-10-22T18:54:00Z'`;
    expect((await tick("2026-10-22T19:00:00Z"))[0]?.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect((await tick("2026-10-22T19:01:00Z"))[0]?.outcome).toBe("busy");
    expect(sent).toHaveLength(1);
  });

  it("skipped when the class is logged", async () => {
    await sql`insert into class_logs (date, heavy_groups, source) values (${THU}, '{}', 'bot')`;
    const r = await tick("2026-10-22T19:00:00Z");
    expect(r[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
    expect((await sql`select status from job_runs`)[0]?.status).toBe("done");
  });

  it("skipped outside the plan", async () => {
    await sql`update plans set weeks = 3`;
    expect((await tick("2026-10-22T19:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("a thrown run is failed and left claimed", async () => {
    const ctx = ctxAt("2026-10-22T19:00:00Z");
    ctx.send = async () => {
      throw new Error("telegram down");
    };
    const r = await runDueJobs(ctx, [classQuestionJob]);
    expect(r[0]?.outcome).toBe("failed");
    expect((await sql`select status from job_runs`)[0]?.status).toBe("claimed");
  });

  it("a throwing window is failed and later jobs still run", async () => {
    const bad: Job = {
      name: "bad",
      window: () => {
        throw new Error("x");
      },
      run: async () => "sent",
    };
    const r = await runDueJobs(ctxAt("2026-10-22T19:00:00Z"), [bad, classQuestionJob]);
    expect(r.map((x) => x.outcome)).toEqual(["failed", "sent"]);
  });
});

describe("morning job", () => {
  /** The fixture only has weeks 1-3: copy week 3 so getSession can read every week up to `n`. */
  const fillWeeks = async (n: number) => {
    await sql`
      insert into plan_weeks (plan_version_id, week, phase, is_deload, is_test, start_date)
      select plan_version_id, g, phase, is_deload, is_test, date '2026-09-28' + (g - 1) * 7
      from plan_weeks, generate_series(4, ${n}::int) g where week = 3`;
  };
  const mtick = (iso: string) => runDueJobs(ctxAt(iso), [morningJob]);
  const TUE = "2026-10-27";
  beforeEach(async () => {
    // The fixture only has weeks 1-3: shift the start so 26-30 Oct is week 3.
    await resetAndSeed(db, sql, { fridaySquat: true });
    await sql`truncate table job_runs restart identity`;
    await sql`update plans set weeks = 12, start_date = '2026-10-12'`;
    await sql`update plan_weeks set start_date = (date '2026-10-12' + (week - 1) * 7)`;
  });

  it("weekday: greeting + exact /today text + 3 morning buttons; readiness and suggestions stored", async () => {
    // History for last week's Tuesday main item, so the engine has something to suggest from.
    const [g] = await sql`
      insert into log_groups (session_date, performed_at, planned_item_id, exercise_id, source)
      select '2026-10-20'::date, '2026-10-20T16:00:00Z', pi.id, o.exercise_id, 'text'
      from planned_items pi join planned_item_options o on o.planned_item_id = pi.id
      where pi.week = 2 and pi.weekday = 'tue' and pi.item_order = 0 and pi.sub_item = 0
      order by o.option_index limit 1 returning id`;
    for (const i of [0, 1, 2]) {
      await sql`insert into log_entries (group_id, set_index, reps, load_kg, rir)
        values (${g?.id as number}, ${i}, 8, 60, 2)`;
    }
    const now = new Date("2026-10-27T05:00:00Z");
    const r = await mtick(now.toISOString());
    expect(r).toEqual([{ job: "morning", date: TUE, outcome: "sent" }]);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Message;
    expect(msg.text.startsWith(MORNING_GREETING)).toBe(true);
    expect(msg.text).toContain((await renderTodayText(db, TUE, now)).text);
    expect(msg.keyboard[0]?.map((b) => b.data)).toEqual([
      "rd:t:m:20261027",
      "rd:o:m:20261027",
      "rd:s:m:20261027",
    ]);
    expect((await sql`select 1 from readiness_logs where date = ${TUE}`).length).toBeGreaterThan(0);
    expect((await sql`select 1 from suggestions`).length).toBeGreaterThan(0);
  });

  it("second run the same day is busy", async () => {
    await mtick("2026-10-27T05:00:00Z");
    sent.length = 0;
    expect((await mtick("2026-10-27T05:15:00Z"))[0]?.outcome).toBe("busy");
    expect(sent).toHaveLength(0);
  });

  it("skipped when a log group exists for the date", async () => {
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source)
      select ${TUE}::date, now(), id, 'text' from exercises limit 1`;
    expect((await mtick("2026-10-27T05:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("skipped before the plan start", async () => {
    await sql`update plans set start_date = '2026-11-02'`;
    expect((await mtick("2026-10-27T05:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("Mon 21 Dec sends the finished text once; Tue 22 Dec is skipped", async () => {
    await sql`update plans set start_date = '2026-09-28'`;
    await fillWeeks(12);
    expect((await mtick("2026-12-21T05:00:00Z"))[0]?.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ text: formatFinished(), keyboard: [] });
    sent.length = 0;
    expect((await mtick("2026-12-22T05:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("Fri 18 Dec (last Friday of the 12-week plan) sends the normal morning message", async () => {
    await sql`update plans set start_date = '2026-09-28'`;
    await fillWeeks(12);
    expect((await mtick("2026-12-18T05:00:00Z"))[0]?.outcome).toBe("sent");
    expect(sent.some((m) => m.text === formatFinished())).toBe(false);
    expect(sent.at(-1)?.text.startsWith(MORNING_GREETING)).toBe(true);
  });

  it("a plan one week longer moves the finished message to the following Monday", async () => {
    await sql`update plans set start_date = '2026-09-28', weeks = 13`;
    await sql`update plan_weeks set start_date = (date '2026-09-28' + (week - 1) * 7)`;
    await fillWeeks(13);
    const r = await mtick("2026-12-21T05:00:00Z");
    expect(r[0]?.outcome).toBe("sent");
    expect(sent.some((m) => m.text === formatFinished())).toBe(false);
    sent.length = 0;
    expect((await mtick("2026-12-28T05:00:00Z"))[0]?.outcome).toBe("sent");
    expect(sent).toEqual([{ text: formatFinished(), keyboard: [] }]);
    sent.length = 0;
    expect((await mtick("2026-12-29T05:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("Friday with Thursday unreported: class card first, then the morning message", async () => {
    await mtick("2026-10-30T05:00:00Z");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.keyboard.flat().some((b) => b.data.startsWith("cg:"))).toBe(true);
    expect(sent[0]?.text).toContain(CLASS_QUESTION);
    expect(sent[1]?.text.startsWith(MORNING_GREETING)).toBe(true);
  });

  it("Friday with Thursday reported: only the morning message", async () => {
    await sql`insert into class_logs (date, heavy_groups, source) values ('2026-10-29', '{}', 'bot')`;
    await mtick("2026-10-30T05:00:00Z");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.startsWith(MORNING_GREETING)).toBe(true);
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
  async function todayViaBot(now: Date): Promise<string> {
    const texts: string[] = [];
    const transformer: Transformer = async (_prev, method, payload) => {
      if (method === "sendMessage") texts.push(String((payload as { text: string }).text));
      return {
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: 42, type: "private" }, text: "" },
      } as never;
    };
    const bot = createBot({ db, now: () => now, token: "123:abc", botInfo, transformer });
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 42, type: "private", first_name: "F" },
        from: { id: 42, is_bot: false, first_name: "F" },
        text: "/today",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    });
    return texts[0] as string;
  }

  it("morning text is exactly greeting + the real /today text + readiness question", async () => {
    const now = new Date("2026-10-27T05:00:00Z");
    await mtick(now.toISOString());
    const viaBot = await todayViaBot(now);
    expect(sent[0]?.text).toBe(`${MORNING_GREETING}\n\n${viaBot}\n\n${READINESS_QUESTION}`);
  });

  it("RED Thursday: the morning message carries the class advice line", async () => {
    await sql`update planned_items set weekday = 'thu', item_order = 9 where week = 3 and weekday = 'tue' and item_order = 1`;
    await sql`insert into readiness_logs (date, at, kind, source, level) values
      ('2026-10-29', '2026-10-29T04:00:00Z', 'button_ok', 'derived', 'RED')`;
    await mtick("2026-10-29T05:00:00Z");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Go easy in class tonight, or skip it.");
  });
});
