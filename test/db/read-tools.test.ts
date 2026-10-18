import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildDynamicText } from "../../src/ai/prompt.js";
import { executeActions } from "../../src/logging/execute.js";
import { listMemory } from "../../src/logging/memory.js";
import { buildPromptContext, MEMORY_CHAR_CAP } from "../../src/logging/prompt-context.js";
import { createLoggingBackend } from "../../src/logging/resolve.js";
import { connect, exId, MON, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Wed 2026-10-14 12:00 Rome: plan week 3, last week = 5-11 Oct, this week = 12-18 Oct. */
const WED = new Date("2026-10-14T10:00:00Z");

async function group(slug: string, date: string, sets: { reps: number; load?: number }[]) {
  const exerciseId = await exId(sql, slug);
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, exercise_id, source)
    values (${date}, ${`${date}T08:00:00Z`}, ${exerciseId}, 'text') returning id`;
  for (const [i, s] of sets.entries()) {
    await sql`insert into log_entries (group_id, set_index, reps, load_kg) values (${g?.id}, ${i + 1}, ${s.reps}, ${s.load ?? null})`;
  }
}

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await group("squat", "2026-10-05", [{ reps: 8, load: 62.5 }]);
  await group("squat", "2026-10-12", [{ reps: 5, load: 55 }]);
  await group("hack_squat", "2026-10-06", [{ reps: 10, load: 100 }]);
});

const facts = async (p: Promise<{ facts: unknown }>) =>
  (await p).facts as Record<string, unknown> & {
    sessions: { date: string; line: string; plan_week: number }[];
  };

describe("backend.getSession", () => {
  it("today by default, with next item, week range and a code fallback", async () => {
    const r = await createLoggingBackend(db, MON).getSession({});
    const f = r.facts as {
      kind: string;
      date: string;
      isToday: boolean;
      weekRange: { start: string; end: string };
      next: { kind: string };
      items: { extras: string[]; fallback: string | null }[];
    };
    expect(f).toMatchObject({ kind: "session", date: "2026-09-28", isToday: true });
    expect(f.weekRange).toMatchObject({ start: "2026-09-28", end: "2026-10-04" });
    expect(f.next.kind).toBe("item");
    expect(f.items[0]).toHaveProperty("extras");
    expect(f.items[0]).toHaveProperty("fallback");
    expect(r.fallbackHtml).toContain("Week 1");
  });

  it("yesterday, tomorrow, a date and a weekday of this week", async () => {
    const b = createLoggingBackend(db, WED);
    const date = async (input: object) =>
      ((await b.getSession(input)).facts as { date: string }).date;
    expect(await date({ day: "yesterday" })).toBe("2026-10-13");
    expect(await date({ day: "tomorrow" })).toBe("2026-10-15");
    expect(await date({ day: "mon" })).toBe("2026-10-12");
    expect(await date({ date: "2026-10-06" })).toBe("2026-10-06");
  });

  it("a rest day, and a bad date is a refused read", async () => {
    const b = createLoggingBackend(db, WED);
    const sat = (await b.getSession({ date: "2026-10-17" })).facts as { kind: string };
    expect(sat.kind).toBe("rest_day");
    const bad = await b.getSession({ date: "2026-02-31" });
    expect(bad.isError).toBe(true);
    expect(bad.fallbackHtml).toBeNull();
  });
});

describe("backend.getExerciseHistory", () => {
  const history = (input: object) =>
    createLoggingBackend(db, WED).getExerciseHistory({
      exercise: { said: "squat" },
      ...input,
    });

  it("all time: newest first with a code-formatted line, no hack squat, and the current e1RM", async () => {
    const r = await history({});
    const f = await facts(Promise.resolve(r));
    expect(f).toMatchObject({
      found: true,
      range_label: "all time",
      total_sessions: 2,
    });
    expect(f).not.toHaveProperty("suggestion");
    // The fixture sets have no RIR logged, so there is no valid set and no e1RM yet.
    expect(f).toHaveProperty("current_e1rm", null);
    expect(f.sessions.map((s) => s.date)).toEqual(["2026-10-12", "2026-10-05"]);
    expect(f.sessions[0]?.line).toContain("1 × 5 · 55 kg");
    expect(r.fallbackHtml).toContain("<b>squat</b>");
  });

  it("this_week and last_week become dates in code", async () => {
    const last = await facts(history({ period: "last_week" }));
    expect(last.range_label).toMatch(/^last week \(/);
    expect(last.sessions.map((s) => s.date)).toEqual(["2026-10-05"]);
    const cur = await facts(history({ period: "this_week" }));
    expect(cur.sessions.map((s) => s.date)).toEqual(["2026-10-12"]);
  });

  it("plan_week 2 and last_n", async () => {
    const f = await facts(history({ plan_week: 2 }));
    expect(f.range_label).toMatch(/^plan week 2 \(/);
    expect(f.sessions.map((s) => s.date)).toEqual(["2026-10-05"]);
    const one = await facts(history({ last_n: 1 }));
    expect(one.sessions).toHaveLength(1);
    expect(one.total_sessions).toBe(2);
    const bad = await history({ plan_week: 12 });
    expect(bad.isError).toBe(true);
  });

  it("hack squat is its own exercise; unknown and ambiguous give found:false", async () => {
    const h = await facts(history({ exercise: { said: "hack squat" } }));
    expect(h.sessions.map((s) => s.date)).toEqual(["2026-10-06"]);
    const un = (await history({ exercise: { said: "zzzz qqqq" } })).facts;
    expect(un).toMatchObject({ found: false, reason: "unknown", candidates: [] });
  });
});

describe("backend.getAlternatives", () => {
  it("returns facts, with active limitations, and no fallback", async () => {
    await sql`insert into memory_items (kind, content, confirmed, active) values ('limitation', 'left shoulder sensitive on dips', true, true), ('preference', 'gone', true, false)`;
    const r = await createLoggingBackend(db, WED).getAlternatives({
      exercise: { said: "squat" },
      want: "machine version",
    });
    expect(r.fallbackHtml).toBeNull();
    expect(r.facts).toMatchObject({
      found: true,
      want: "machine version",
      limitations: ["left shoulder sensitive on dips"],
      preferences: [],
    });
  });
});

describe("save_memory", () => {
  it("is staged by the backend and written only by the executor, in the ledger", async () => {
    const b = createLoggingBackend(db, WED);
    const staged = await b.stageSaveMemory({
      kind: "limitation",
      content: "left shoulder sensitive on dips",
    });
    if (!staged.ok) throw new Error("not staged");
    expect(await listMemory(db)).toHaveLength(0);
    const r = await executeActions(db, "p:1", [staged.action], { now: WED });
    expect(r.status).toBe("done");
    const [item] = await listMemory(db);
    expect(item).toMatchObject({
      kind: "limitation",
      content: "left shoulder sensitive on dips",
      confirmed: true,
      active: true,
    });
    // a retry with the same key writes nothing more
    await executeActions(db, "p:1", [staged.action], { now: WED });
    expect(await listMemory(db)).toHaveLength(1);
  });
});

describe("prompt memory block", () => {
  it("injects active limitations and preferences, never deleted items or aliases", async () => {
    await sql`insert into memory_items (kind, content, confirmed, active) values
      ('limitation', 'left shoulder sensitive on dips', true, true),
      ('preference', 'cable face pulls over band', true, true),
      ('limitation', 'old injury', true, false),
      ('alias', '"sq" = Squat', true, true)`;
    const ctx = await buildPromptContext(db, 1, WED);
    expect(ctx.memory).toEqual([
      { kind: "preference", content: "cable face pulls over band" },
      { kind: "limitation", content: "left shoulder sensitive on dips" },
    ]);
    const text = buildDynamicText(ctx);
    expect(text).toContain("- limitation: left shoulder sensitive on dips");
    expect(text).not.toContain("old injury");
  });

  it("caps the block by size and keeps the newest", async () => {
    for (let i = 1; i <= 40; i++) {
      await sql`insert into memory_items (kind, content, confirmed, active) values ('preference', ${`item ${i} ${"x".repeat(190)}`}, true, true)`;
    }
    const ctx = await buildPromptContext(db, 1, WED);
    const chars = ctx.memory.reduce((n, m) => n + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(MEMORY_CHAR_CAP);
    expect(ctx.memory.length).toBeLessThan(40);
    expect(ctx.memory[0]?.content.startsWith("item 40 ")).toBe(true);
    expect(ctx.memory.some((m) => m.content.startsWith("item 1 "))).toBe(false);
  });
});
