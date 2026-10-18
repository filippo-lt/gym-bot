import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSession, getWeek } from "../../src/bot/session.js";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { insertDeload } from "../../src/plan/deload.js";
import { applySwap } from "../../src/plan/swap-transform.js";
import { createVersion, loadLatestContent } from "../../src/plan/versions.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { getAlternativeFacts } from "../../src/queries/alternatives.js";
import { getExerciseHistory } from "../../src/queries/history.js";
import { getPlanOverview } from "../../src/queries/plan-overview.js";
import { readExerciseHistory } from "../../src/queries/read-tools.js";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table log_entries, log_groups, session_items, memory_items, session_overrides, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
});

const START = "2026-09-28";
const DELOADS = [4, 8, 12];

function item(
  week: number,
  weekday: "mon" | "tue",
  options: string[],
  over: Partial<ParsedItem> = {},
): ParsedItem {
  return {
    key: `w${String(week).padStart(2, "0")}-${weekday}-00-0`,
    week,
    weekday,
    order: 0,
    sub_item: 0,
    block: "Main",
    plan_name: options.join(" / "),
    exercise_options: options,
    variant_label: null,
    prescription_raw: "4 × 5",
    extras_raw: null,
    sets_min: 4,
    sets_max: 4,
    reps_min: 5,
    reps_max: 5,
    per_side: false,
    duration_s_min: null,
    duration_s_max: null,
    hiit: null,
    tempo: null,
    modifiers: DELOADS.includes(week) ? ["deload"] : [],
    hspu_step: null,
    rir_min: 2,
    rir_max: 3,
    tags: ["squat"],
    rest_raw: "2 min",
    priority: "High",
    note: null,
    time_raw: "15 min",
    time_min_min: 15,
    time_min_max: 15,
    fallback_prescription: null,
    flags: [],
    ...over,
  };
}

function ex(slug: string, name: string): ResolvedPlan["plan"]["exercises"][number] {
  return {
    slug,
    name,
    aliases: [],
    muscle_group: "legs",
    type: "weighted",
    load_basis: "stack",
    equipment_slug: null,
    is_main_lift: false,
    review_note: null,
  };
}

function fixture(): ResolvedPlan {
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    week: i + 1,
    phase: "Base",
    is_deload: DELOADS.includes(i + 1),
    is_test: false,
    start_date: addDays(START, 7 * i),
  }));
  const items = weeks.flatMap((w) => [
    item(w.week, "mon", ["squat", "hack_squat"]),
    item(w.week, "tue", ["pullup"], { tags: ["vertical_pull"] }),
  ]);
  return {
    open_issues: [],
    resolved_hash: "resolved-a",
    plan: {
      source_hash: "hash-a",
      name: "Test Plan",
      start_date: START,
      weeks_count: 12,
      weeks,
      equipment: [],
      hspu_ladder: [],
      exercises: [
        ex("squat", "Squat"),
        ex("hack_squat", "Hack squat"),
        ex("leg_press", "Leg press"),
        ex("pullup", "Pull-up"),
        ex("ring_row", "Ring row"),
      ],
      items,
    },
  };
}

async function setup() {
  await seedPlan(db, fixture());
  const [plan] = await sql`select id from plans`;
  const planId = plan?.id as number;
  const exId = async (slug: string) =>
    (await sql`select id from exercises where slug = ${slug}`)[0]?.id as number;
  return { planId, exId };
}

async function addSwapVersion(planId: number, from: number, to: number, fromDate: string) {
  const base = await db.transaction((tx) => loadLatestContent(tx, planId));
  const { content } = applySwap(base.content, {
    fromExerciseId: from,
    toExerciseId: to,
    fromDate,
    weekdays: "all",
    clearHspuStep: false,
    rirFor: (i) => ({ rirMin: i.rirMin, rirMax: i.rirMax }),
  });
  return db.transaction((tx) =>
    createVersion(tx, {
      planId,
      baseVersionId: base.versionId,
      content,
      effectiveFrom: fromDate,
      reason: "swap",
      change: { kind: "swap", from, to, weekdays: "all", fromDate },
    }),
  );
}

async function itemId(key: string, version = 1) {
  const rows =
    await sql`select i.id from planned_items i join plan_versions v on v.id = i.plan_version_id where i.item_key = ${key} and v.version = ${version}`;
  return rows[0]?.id as number;
}

async function addDeloadVersion(planId: number, at: number, effectiveFrom: string) {
  const base = await db.transaction((tx) => loadLatestContent(tx, planId));
  const ins = insertDeload(base.content, at);
  return db.transaction((tx) =>
    createVersion(tx, {
      planId,
      baseVersionId: base.versionId,
      content: ins.content,
      effectiveFrom,
      reason: "deload",
      change: { kind: "deload_earlier", insertedWeek: at, droppedWeek: ins.droppedWeek },
    }),
  );
}

describe("bot session readers across versions", () => {
  it("getSession for a past date is unchanged by later versions", async () => {
    const { planId, exId } = await setup();
    const dates = ["2026-10-06", "2026-10-13", "2026-10-17"];
    const before = [];
    for (const d of dates) before.push(await getSession(db, d));
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-20");
    await addDeloadVersion(planId, 6, "2026-11-02");
    const after = [];
    for (const d of dates) after.push(await getSession(db, d));
    expect(after).toEqual(before);
    expect(before[1]).toMatchObject({ kind: "session", weekday: "tue" });
  });

  it("getSession uses the new version from its effective date and names the swap", async () => {
    const { planId, exId } = await setup();
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-20");
    const s = await getSession(db, "2026-10-20");
    if (s.kind !== "session") throw new Error("x");
    expect(s.items[0]?.options.map((o) => o.slug)).toEqual(["ring_row"]);
    expect(s.items[0]?.swappedFrom).toBeNull();
    // A one-off override shows the replaced name.
    const id = await itemId("w05-mon-00-0", 2);
    await sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values ('2026-10-26', ${id}, ${await exId("hack_squat")}, ${await exId("leg_press")})`;
    const o = await getSession(db, "2026-10-26");
    if (o.kind !== "session") throw new Error("x");
    expect(o.items[0]?.options.map((x) => x.slug)).toEqual(["squat", "leg_press"]);
    expect(o.items[0]?.swappedFrom).toBe("Hack squat");
  });

  it("a week straddling v1 and v2 counts each day under its own version", async () => {
    const { planId, exId } = await setup();
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-20");
    // Week 4: Monday 19 Oct is v1, Tuesday 20 Oct is v2.
    const monV1 = await itemId("w04-mon-00-0", 1);
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-10-19', ${monV1}, 'done', 'bot')`;
    const w = await getWeek(db, "2026-10-21");
    if (w.kind !== "week") throw new Error("x");
    expect(w.week).toBe(4);
    expect(w.days[0]).toMatchObject({ weekday: "mon", total: 1, done: 1 });
    expect(w.days[1]).toMatchObject({ weekday: "tue", total: 1, done: 0 });
    const tueV2 = await itemId("w04-tue-00-0", 2);
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-10-20', ${tueV2}, 'done', 'bot')`;
    const w2 = await getWeek(db, "2026-10-21");
    if (w2.kind !== "week") throw new Error("x");
    expect(w2.days[1]).toMatchObject({ weekday: "tue", total: 1, done: 1 });
  });

  it("finished follows the version's week count", async () => {
    const { planId } = await setup();
    expect(await getSession(db, "2026-12-21")).toEqual({ kind: "finished" });
    await addDeloadVersion(planId, 6, "2026-11-02");
    expect(await getSession(db, "2026-12-21")).toMatchObject({ kind: "session", week: 13 });
    expect(await getSession(db, "2026-12-28")).toEqual({ kind: "finished" });
    expect(await getWeek(db, "2026-12-28")).toEqual({ kind: "finished" });
  });
});

describe("plan overview", () => {
  it("shows 13 weeks and the moved deload after an insert", async () => {
    const { planId } = await setup();
    await addDeloadVersion(planId, 6, "2026-11-02");
    const o = await getPlanOverview(db, "2026-11-09");
    expect(o?.status).toBe("active");
    expect(o?.week).toBe(7);
    expect(o?.nextDeload).toEqual({ week: 9, startDate: "2026-11-23" });
    expect(o?.phases.at(-1)?.toWeek).toBe(13);
    const before = await getPlanOverview(db, "2026-10-26");
    expect(before?.phases.at(-1)?.toWeek).toBe(12);
    expect(before?.nextDeload).toEqual({ week: 8, startDate: "2026-11-16" });
  });
});

describe("history and alternatives", () => {
  async function log(date: string, key: string, version: number, exerciseId: number) {
    const item = await itemId(key, version);
    const [g] =
      await sql`insert into log_groups (session_date, performed_at, planned_item_id, exercise_id, source) values (${date}, ${`${date}T10:00:00Z`}, ${item}, ${exerciseId}, 'text') returning id`;
    await sql`insert into log_entries (group_id, set_index, reps, load_kg) values (${g?.id as number}, 1, 5, 100)`;
  }

  it("lists week, phase and deload flag per date from the version of that date", async () => {
    const { planId, exId } = await setup();
    const squat = await exId("squat");
    // v2 inserts a deload at week 3 but only from 2 Nov: 13 Oct is v1 (week 3, not deload).
    await addDeloadVersion(planId, 3, "2026-11-02");
    await log("2026-10-12", "w03-mon-00-0", 1, squat);
    await log("2026-11-09", "w03-mon-00-0", 2, squat);
    const h = await getExerciseHistory(db, squat, { limit: 5 });
    const byDate = new Map(h?.sessions.map((s) => [s.sessionDate, s]));
    expect(byDate.get("2026-11-09")).toMatchObject({ week: 7 });
    expect(byDate.get("2026-10-12")).toMatchObject({ week: 3, isDeload: false });
  });

  it("plan_week turns into dates through the version effective today, and rejects past its count", async () => {
    const { planId } = await setup();
    await addDeloadVersion(planId, 6, "2026-11-02");
    const ask = (week: number, now: string) =>
      readExerciseHistory(db, new Date(now), {
        exercise: { said: "squat", slug: "squat" },
        plan_week: week,
      });
    const ok = await ask(13, "2026-11-09T09:00:00Z");
    expect(ok.facts).toMatchObject({
      found: true,
      range_label: expect.stringContaining("plan week 13"),
    });
    // Before the insert is effective, the plan has 12 weeks.
    const refused = await ask(13, "2026-10-26T09:00:00Z");
    expect(JSON.stringify(refused.facts)).toContain("no week 13");
  });

  it("alternatives: planned from the version effective today, future dates only", async () => {
    const { planId, exId } = await setup();
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-20");
    const pullup = await getAlternativeFacts(db, { id: await exId("pullup") }, "2026-10-20");
    expect(pullup?.plannedIn).toEqual([]);
    const row = await getAlternativeFacts(db, { id: await exId("ring_row") }, "2026-10-20");
    expect(row?.plannedIn.map((p) => p.weekday)).toEqual(["tue"]);
    const early = await getAlternativeFacts(db, { id: await exId("pullup") }, "2026-10-13");
    expect(early?.plannedIn.map((p) => p.weekday)).toEqual(["tue"]);
    // Past the last pull-up date of the plan nothing is left.
    const late = await getAlternativeFacts(db, { id: await exId("squat") }, "2026-12-21");
    expect(late?.plannedIn).toEqual([]);
  });
});
