import { sql } from "drizzle-orm";
import type { Message } from "../bot/log-format.js";
import type { Db } from "../db/client.js";

/** A claimed job that never finished can be taken again after this long (the window still applies). */
export const JOB_RECLAIM_MS = 5 * 60_000;

export interface JobContext {
  db: Db;
  now: Date;
  send(m: Message): Promise<void>;
}

export interface Job {
  name: string;
  /** The day this job is due for at `now` (Rome), or null outside its window. */
  window(now: Date): { date: string } | null;
  run(ctx: JobContext, date: string): Promise<"sent" | "skipped">;
}

export type JobOutcome = "sent" | "skipped" | "busy" | "failed";

/** One statement: insert the claim, or re-take a stale `claimed` row. A `done` row never matches. */
async function claim(ctx: JobContext, job: string, date: string): Promise<boolean> {
  const now = ctx.now.toISOString();
  const stale = new Date(ctx.now.getTime() - JOB_RECLAIM_MS).toISOString();
  const rows = await ctx.db.execute(sql`
    insert into job_runs (job, date, status, claimed_at)
    values (${job}, ${date}, 'claimed', ${now}::timestamptz)
    on conflict (job, date) do update set claimed_at = excluded.claimed_at
    where job_runs.status = 'claimed' and job_runs.claimed_at < ${stale}::timestamptz
    returning id`);
  return rows.length > 0;
}

async function markDone(ctx: JobContext, job: string, date: string): Promise<void> {
  await ctx.db.execute(sql`
    update job_runs set status = 'done', done_at = ${ctx.now.toISOString()}::timestamptz
    where job = ${job} and date = ${date}`);
}

/** For each job due now: claim, run, mark done. One job failing never stops the others. */
export async function runDueJobs(
  ctx: JobContext,
  jobs: Job[],
): Promise<{ job: string; date: string; outcome: JobOutcome }[]> {
  const results: { job: string; date: string; outcome: JobOutcome }[] = [];
  for (const job of jobs) {
    let date = "";
    try {
      const win = job.window(ctx.now);
      if (!win) continue;
      date = win.date;
      if (!(await claim(ctx, job.name, date))) {
        results.push({ job: job.name, date, outcome: "busy" });
        continue;
      }
      const outcome = await job.run(ctx, date);
      await markDone(ctx, job.name, date);
      results.push({ job: job.name, date, outcome });
    } catch (error) {
      // The row stays `claimed`: it is taken again after JOB_RECLAIM_MS while the window lasts.
      console.error("job failed:", job.name, error instanceof Error ? error.name : "");
      results.push({ job: job.name, date, outcome: "failed" });
    }
  }
  return results;
}
