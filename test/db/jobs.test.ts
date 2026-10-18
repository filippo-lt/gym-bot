import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/bot/log-format.js";
import { classQuestionJob } from "../../src/jobs/class-question.js";
import { type Job, type JobContext, runDueJobs } from "../../src/jobs/runner.js";
import { connect, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`truncate table job_runs restart identity`;
  // The fixture plan has 3 week rows; the dates below fall in week 4-5.
  await addWeeks(4, 12);
});

async function addWeeks(from: number, to: number) {
  const [v] = await sql`select id from plan_versions order by version desc limit 1`;
  for (let w = from; w <= to; w += 1) {
    await sql`insert into plan_weeks (plan_version_id, week, phase, is_deload, is_test, start_date)
      values (${v?.id as number}, ${w}, 'Base', false, false, (date '2026-09-28' + ${7 * (w - 1)}::int))`;
  }
}

const THU = "2026-10-22";
const sent: Message[] = [];
const ctxAt = (iso: string): JobContext => ({
  db,
  now: new Date(iso),
  send: async (m) => {
    sent.push(m);
  },
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
    await sql`delete from plan_weeks where week > 3`;
    expect((await tick("2026-10-22T19:00:00Z"))[0]?.outcome).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("runs in week 13 of a 13-week version", async () => {
    await addWeeks(13, 13);
    // Thursday of week 13 (2026-09-28 + 12 weeks + 3 days).
    const r = await tick("2026-12-24T20:00:00Z");
    expect(r).toEqual([{ job: "class_question", date: "2026-12-24", outcome: "sent" }]);
  });

  it("is skipped after the last week of the version", async () => {
    await addWeeks(13, 13);
    expect((await tick("2027-01-07T20:00:00Z"))[0]?.outcome).toBe("skipped");
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
