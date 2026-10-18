import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBot } from "../../src/bot/bot.js";
import { historyLines } from "../../src/bot/query-format.js";
import { getSession } from "../../src/bot/session.js";
import { getAlternativeFacts } from "../../src/queries/alternatives.js";
import { lookupExercise } from "../../src/queries/exercise-lookup.js";
import { getExerciseHistory } from "../../src/queries/history.js";
import { getPlanOverview, nextItem } from "../../src/queries/plan-overview.js";
import { connect, exId, MON, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface SetRow {
  reps?: number | null;
  load?: number | null;
  added?: number | null;
  assist?: number | null;
  rir?: number | null;
  rirPlus?: boolean;
  clean?: boolean | null;
  pad?: number | null;
}

async function group(
  slug: string,
  date: string,
  hour: number,
  source: "text" | "import",
  sets: SetRow[],
  perSetUnknown = false,
): Promise<number> {
  const exerciseId = await exId(sql, slug);
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, exercise_id, source, per_set_unknown)
    values (${date}, ${`${date}T${String(hour).padStart(2, "0")}:00:00Z`}, ${exerciseId}, ${source}, ${perSetUnknown})
    returning id`;
  for (const [i, s] of sets.entries()) {
    await sql`
      insert into log_entries (group_id, set_index, reps, load_kg, added_kg, assist_kg, rir, rir_plus, clean, pad_height)
      values (${g?.id}, ${i + 1}, ${s.reps ?? null}, ${s.load ?? null}, ${s.added ?? null}, ${s.assist ?? null},
        ${s.rir ?? null}, ${s.rirPlus ?? false}, ${s.clean ?? null}, ${s.pad ?? null})`;
  }
  return g?.id as number;
}

async function seedLogs() {
  // squat: an imported total-only day, two bot days (one split over two groups), one before the plan
  await group("squat", "2026-09-20", 8, "text", [{ reps: 5, load: 50 }]);
  await group(
    "squat",
    "2026-09-28",
    8,
    "import",
    [{ reps: 18, load: 60, rir: 4, rirPlus: true }],
    true,
  );
  await group("squat", "2026-10-05", 8, "text", [
    { reps: 8, load: 62.5 },
    { reps: 8, load: 62.5 },
    { reps: 8, load: 62.5, rir: 2 },
  ]);
  // Same day, logged in two groups; the later group is inserted first on purpose.
  await group("squat", "2026-10-12", 9, "text", [{ reps: 5, load: 55, rir: 3 }]);
  await group("squat", "2026-10-12", 8, "text", [
    { reps: 5, load: 55 },
    { reps: 5, load: 55 },
  ]);
  await group("hack_squat", "2026-10-06", 8, "text", [
    { reps: 10, load: 100 },
    { reps: 10, load: 100 },
  ]);
  await group("pull_up", "2026-10-05", 8, "text", [
    { reps: 4, added: 10, clean: true },
    { reps: 4, added: 10, clean: true },
  ]);
  await group("pull_up", "2026-10-06", 8, "text", [{ reps: 5, assist: 15, clean: false }]);
}

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await seedLogs();
});

describe("getExerciseHistory", () => {
  it("newest first, per exercise, with plan weeks, source and merged same-day groups", async () => {
    const h = await getExerciseHistory(db, await exId(sql, "squat"));
    expect(h?.exercise.slug).toBe("squat");
    expect(h?.totalSessions).toBe(4);
    expect(h?.sessions.map((s) => s.sessionDate)).toEqual([
      "2026-10-12",
      "2026-10-05",
      "2026-09-28",
      "2026-09-20",
    ]);
    expect(h?.sessions.map((s) => s.week)).toEqual([3, 2, 1, null]);
    expect(h?.sessions.map((s) => s.isDeload)).toEqual([true, false, false, false]);
    expect(h?.sessions.map((s) => s.source)).toEqual(["bot", "bot", "import", "bot"]);
    expect(h?.sessions.map((s) => s.weekday)).toEqual(["mon", "mon", "mon", "sun"]);

    // 12 Oct: two groups merged in performed_at order, set indexes renumbered.
    const merged = h?.sessions[0]?.sets;
    expect(merged?.map((s) => [s.setIndex, s.reps, s.loadKg, s.rir])).toEqual([
      [1, 5, 55, null],
      [2, 5, 55, null],
      [3, 5, 55, 3],
    ]);

    // Imported total-only day: one set carrying the total, "4+" kept.
    const unknown = h?.sessions[2];
    expect(unknown?.perSetUnknown).toBe(true);
    expect(unknown?.sets).toHaveLength(1);
    expect(unknown?.sets[0]).toMatchObject({ reps: 18, loadKg: 60, rir: 4, rirPlus: true });
  });

  it("squat and hack squat never mix", async () => {
    const hack = await getExerciseHistory(db, await exId(sql, "hack_squat"));
    expect(hack?.sessions.map((s) => s.sessionDate)).toEqual(["2026-10-06"]);
    expect(hack?.sessions[0]?.sets.map((s) => s.loadKg)).toEqual([100, 100]);
    const squat = await getExerciseHistory(db, await exId(sql, "squat"));
    expect(squat?.sessions.some((s) => s.sessionDate === "2026-10-06")).toBe(false);
  });

  it("pull-ups keep added and assist apart", async () => {
    const h = await getExerciseHistory(db, await exId(sql, "pull_up"));
    expect(
      h?.sessions.map((s) => [s.sessionDate, s.sets[0]?.addedKg, s.sets[0]?.assistKg]),
    ).toEqual([
      ["2026-10-06", null, 15],
      ["2026-10-05", 10, null],
    ]);
    expect(historyLines(h as NonNullable<typeof h>)).toEqual([
      "Tue 6 Oct · W2 — 1 × 5 · 15 kg assist · not clean",
      "Mon 5 Oct · W2 — 2 × 4 · +10 kg · clean",
    ]);
  });

  it("limit, clamp, since and until", async () => {
    const id = await exId(sql, "squat");
    const two = await getExerciseHistory(db, id, { limit: 2 });
    expect(two?.sessions.map((s) => s.sessionDate)).toEqual(["2026-10-12", "2026-10-05"]);
    expect(two?.totalSessions).toBe(4);
    expect((await getExerciseHistory(db, id, { limit: 99 }))?.sessions).toHaveLength(4);
    expect((await getExerciseHistory(db, id, { limit: 0 }))?.sessions).toHaveLength(1);
    const range = await getExerciseHistory(db, id, { since: "2026-09-28", until: "2026-10-05" });
    expect(range?.sessions.map((s) => s.sessionDate)).toEqual(["2026-10-05", "2026-09-28"]);
    expect(range?.totalSessions).toBe(2);
  });

  it("an exercise without logs, and an unknown id", async () => {
    const none = await getExerciseHistory(db, await exId(sql, "bench_press"));
    expect(none).toMatchObject({ totalSessions: 0, sessions: [] });
    expect(none?.exercise.slug).toBe("bench_press");
    expect(await getExerciseHistory(db, 999_999)).toBeNull();
  });

  it("formats the real rows", async () => {
    const h = await getExerciseHistory(db, await exId(sql, "squat"));
    expect(historyLines(h as NonNullable<typeof h>)).toEqual([
      "Mon 12 Oct · W3 deload — 3 × 5 · 55 kg · RIR 3",
      "Mon 5 Oct · W2 — 3 × 8 · 62.5 kg · RIR 2",
      "Mon 28 Sep · W1 — 18 reps total (split unknown) · 60 kg · RIR 4+ · imported",
      "Sun 20 Sep — 1 × 5 · 50 kg",
    ]);
  });
});

describe("lookupExercise", () => {
  it("resolves against the real catalog", async () => {
    const r = await lookupExercise(db, "hack squat");
    expect(r.kind === "ok" && r.exercise.slug).toBe("hack_squat");
    const s = await lookupExercise(db, "squat");
    expect(s.kind === "ok" && s.exercise.slug).toBe("squat");
    expect((await lookupExercise(db, "squat / hack squat")).kind).toBe("ambiguous");
    expect((await lookupExercise(db, "qqqq")).kind).toBe("unknown");
  });
});

describe("getPlanOverview", () => {
  it("groups phases and finds the next deload", async () => {
    await sql`update plan_weeks set phase = 'Strength' where week = 2`;
    const o = await getPlanOverview(db, "2026-09-30");
    expect(o).toMatchObject({
      status: "active",
      week: 1,
      phase: "Base",
      weekStart: "2026-09-28",
      weekEnd: "2026-10-04",
      nextDeload: { week: 3, startDate: "2026-10-12" },
      nextTrainingDay: { date: "2026-09-30", weekday: "wed", focus: "HIIT + mobility" },
    });
    expect(o?.phases).toEqual([
      { fromWeek: 1, toWeek: 1, phase: "Base" },
      { fromWeek: 2, toWeek: 2, phase: "Strength" },
      { fromWeek: 3, toWeek: 3, phase: "Base" },
    ]);
  });

  it("consecutive weeks of one phase merge", async () => {
    const o = await getPlanOverview(db, "2026-09-30");
    expect(o?.phases).toEqual([{ fromWeek: 1, toWeek: 3, phase: "Base" }]);
  });

  it("weekend: the next training day is Monday; the deload week counts as next", async () => {
    const o = await getPlanOverview(db, "2026-10-03");
    expect(o?.nextTrainingDay).toEqual({
      date: "2026-10-05",
      weekday: "mon",
      focus: "Pull + hinge",
    });
    const deload = await getPlanOverview(db, "2026-10-14");
    expect(deload?.nextDeload).toEqual({ week: 3, startDate: "2026-10-12" });
    expect(deload?.week).toBe(3);
  });

  it("before the start", async () => {
    const o = await getPlanOverview(db, "2026-09-20");
    expect(o).toMatchObject({
      status: "before_start",
      week: null,
      phase: null,
      weekStart: null,
      nextDeload: { week: 3, startDate: "2026-10-12" },
      nextTrainingDay: { date: "2026-09-28", weekday: "mon" },
    });
  });

  it("finished: no deload and no training day", async () => {
    const lastSunday = await getPlanOverview(db, "2026-10-18");
    expect(lastSunday).toMatchObject({ status: "active", week: 3, nextTrainingDay: null });
    const o = await getPlanOverview(db, "2026-10-19");
    expect(o).toMatchObject({
      status: "finished",
      week: null,
      nextDeload: null,
      nextTrainingDay: null,
    });
    expect(o?.phases).toHaveLength(1);
  });
});

describe("nextItem on a real session", () => {
  it("first open item, skipping settled ones; exposure never counts", async () => {
    const first = nextItem(await getSession(db, "2026-09-28"));
    expect(first.kind === "item" && first.item.planName).toBe("Warm-up");

    const rows = await sql`
      select id, plan_name from planned_items
      where week = 1 and weekday = 'mon' and sub_item = 0 order by item_order limit 2`;
    for (const [i, r] of rows.entries()) {
      await sql`insert into session_items (session_date, planned_item_id, status, source)
        values ('2026-09-28', ${r.id}, ${i === 0 ? "done" : "skipped"}, 'bot')`;
    }
    const next = nextItem(await getSession(db, "2026-09-28"));
    expect(next.kind === "item" && next.item.planName).toBe("Chest-supported row");
    expect(next.kind === "item" && next.position).toBe(3);

    // Thursday holds a class and an exposure row: once the class is done nothing is left.
    const [thu] = await sql`select id from planned_items
      where week = 1 and weekday = 'thu' and plan_name = 'Calisthenics class'`;
    expect(nextItem(await getSession(db, "2026-10-01")).kind).toBe("item");
    await sql`insert into session_items (session_date, planned_item_id, status, source)
      values ('2026-10-01', ${thu?.id}, 'done', 'bot')`;
    expect(nextItem(await getSession(db, "2026-10-01"))).toEqual({ kind: "all_done" });

    expect(nextItem(await getSession(db, "2026-10-03"))).toEqual({ kind: "rest" });
    expect(nextItem(await getSession(db, "2026-09-20"))).toEqual({ kind: "before_start" });
    expect(nextItem(await getSession(db, "2026-10-19"))).toEqual({ kind: "finished" });
  });
});

describe("getAlternativeFacts", () => {
  beforeEach(async () => {
    // The fixture items carry no tags: give the ones we need some.
    await sql`update planned_items set tags = '{squat,hinge}' where plan_name = 'Squat / hack squat'`;
    await sql`update planned_items set tags = '{squat,accessory}' where plan_name = 'Hack squat solo'`;
    await sql`update planned_items set tags = '{row}' where plan_name in ('Chest-supported row','Cable row')`;
    await sql`update planned_items set tags = '{vertical_pull,skill_strength}' where plan_name in ('Clean strict pull-up','Weighted pull-up')`;
    await sql`insert into memory_items (kind, content, confirmed, active) values
      ('limitation', 'Left shoulder sensitive on dips', true, true),
      ('limitation', 'Old injury', true, false),
      ('preference', 'Prefers machines', true, true),
      ('alias', '"fp" = Face pull', true, true)`;
  });

  it("tags come from single-option items first; OR items only as a fallback", async () => {
    const hack = await getAlternativeFacts(db, { id: await exId(sql, "hack_squat") }, "2026-09-28");
    expect(hack?.movementTags).toEqual(["squat"]);
    const squat = await getAlternativeFacts(db, { id: await exId(sql, "squat") }, "2026-09-28");
    expect([...(squat?.movementTags ?? [])].sort()).toEqual(["hinge", "squat"]);
  });

  it("describes where it is planned and what shares its pattern", async () => {
    const f = await getAlternativeFacts(db, { id: await exId(sql, "cable_row") }, "2026-09-28");
    expect(f?.exercise).toMatchObject({ slug: "cable_row", type: "weighted", loadBasis: "stack" });
    expect(f?.exercise.equipment).toBe("Cable stack");
    expect(f?.plannedIn).toEqual([
      { weekday: "mon", block: "Main", planName: "Cable row", priority: "High" },
    ]);
    expect(f?.samePatternInCatalog).toEqual([
      { slug: "ring_row", name: "ring_row", equipment: null },
    ]);

    const pull = await getAlternativeFacts(db, { id: await exId(sql, "pull_up") }, "2026-09-28");
    expect(pull?.movementTags).toEqual(["vertical_pull"]);
    expect(pull?.plannedIn.map((p) => p.planName)).toEqual([
      "Clean strict pull-up",
      "Weighted pull-up",
    ]);
    expect(pull?.samePatternInCatalog).toEqual([]);

    // An OR option never pulls the other option's pattern in via its own item.
    const hack = await getAlternativeFacts(db, { id: await exId(sql, "hack_squat") }, "2026-09-28");
    expect(hack?.samePatternInCatalog).toEqual([]);
  });

  it("same-pattern exercises come from the version effective today", async () => {
    await sql`insert into plan_versions (plan_id, version, effective_from, reason, source_hash, resolved_hash)
      select plan_id, 2, '2026-09-29', 'empty', source_hash, resolved_hash from plan_versions where version = 1`;
    const f = await getAlternativeFacts(db, { id: await exId(sql, "cable_row") }, "2026-10-01");
    expect(f?.movementTags).toEqual(["row"]);
    expect(f?.samePatternInCatalog).toEqual([]);
  });

  it("returns active limitations and preferences only", async () => {
    const f = await getAlternativeFacts(db, { id: await exId(sql, "bench_press") }, "2026-09-28");
    expect(f?.limitations).toEqual(["Left shoulder sensitive on dips"]);
    expect(f?.preferences).toEqual(["Prefers machines"]);
    expect(f?.movementTags).toEqual([]);
    expect(await getAlternativeFacts(db, { id: 999_999 }, "2026-09-28")).toBeNull();
  });
});

describe("the commands over the real database", () => {
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
  const CHAT = { id: 42, type: "private" as const, first_name: "F" };
  const FROM = { id: 42, is_bot: false, first_name: "F" };

  function setup() {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const transformer: Transformer = async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true } as never;
    };
    // No AI configured: the commands must work without it.
    const bot = createBot({ db, now: () => MON, token: "123:abc", botInfo, transformer });
    let id = 5000;
    const say = (text: string) =>
      bot.handleUpdate({
        update_id: ++id,
        message: {
          message_id: id,
          date: 0,
          chat: CHAT,
          from: FROM,
          text,
          entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
        },
      });
    const tap = (data: string) =>
      bot.handleUpdate({
        update_id: ++id,
        callback_query: {
          id: `cb${id}`,
          chat_instance: "x",
          from: FROM,
          message: { message_id: 1, date: 0, chat: CHAT },
          data,
        },
      });
    const texts = () =>
      calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
    return { calls, say, tap, texts };
  }

  it("/history squat and /history hack squat", async () => {
    const { say, texts } = setup();
    await say("/history squat");
    await say("/history hack squat");
    const [squat, hack] = texts();
    expect(squat).toContain("<b>squat</b> — 4 sessions");
    expect(squat).toContain("Mon 12 Oct · W3 deload — 3 × 5 · 55 kg · RIR 3");
    expect(squat).not.toContain("100 kg");
    expect(hack).toContain("Tue 6 Oct · W2 — 2 × 10 · 100 kg");
    expect(hack).not.toContain("55 kg");
  });

  it("an ambiguous /history offers buttons and the tap sends that exercise", async () => {
    const { say, tap, calls, texts } = setup();
    await say("/history squat / hack squat");
    const markup = calls[0]?.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    const data = markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toEqual([`hx:${await exId(sql, "squat")}`, `hx:${await exId(sql, "hack_squat")}`]);
    await tap(data[1] as string);
    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "answerCallbackQuery",
      "sendMessage",
    ]);
    expect(texts()[1]).toContain("<b>hack_squat</b>");
  });

  it("/next, /session and /plan", async () => {
    const { say, texts } = setup();
    await say("/next");
    await say("/session fri");
    await say("/session sun");
    await say("/plan");
    const [next, fri, sun, plan] = texts();
    expect(next).toContain("<b>Next up</b> · 1 of");
    expect(fri).toContain("Fri 2 Oct");
    expect(fri).not.toContain("Today");
    expect(sun).toContain("Rest day");
    expect(plan).toContain("<b>Week 1 · Base</b> · 28 Sep – 4 Oct");
    expect(plan).toContain("Phases: W1–3 Base");
    expect(plan).toContain("Next deload: week 3 (from Mon 12 Oct)");
  });
});
