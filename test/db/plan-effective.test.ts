import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { insertDeload } from "../../src/plan/deload.js";
import type { PlanDay } from "../../src/plan/effective.js";
import {
  loadVersionIndex,
  planDayOn,
  planDaysBetween,
  versionOn,
} from "../../src/plan/effective.js";
import { applySwap } from "../../src/plan/swap-transform.js";
import { createVersion, loadLatestContent } from "../../src/plan/versions.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table session_overrides, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
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

const slugs = (day: Awaited<ReturnType<typeof planDayOn>>, idx = 0) =>
  day.kind === "day" ? (day.items[idx]?.options.map((o) => o.slug) ?? []) : [];

describe("planDayOn", () => {
  it("no plan", async () => {
    expect(await planDayOn(db, "2026-10-05")).toEqual({ kind: "no_plan" });
    expect(await versionOn(db, "2026-10-05")).toBeNull();
  });

  it("before start, weekend rest, plain day", async () => {
    await setup();
    expect(await planDayOn(db, "2026-09-27")).toEqual({
      kind: "before_start",
      startDate: START,
    });
    const rest = await planDayOn(db, "2026-10-03");
    expect(rest).toMatchObject({ kind: "rest", week: 1, phase: "Base", weeksTotal: 12 });
    const day = await planDayOn(db, "2026-10-05");
    expect(day).toMatchObject({ kind: "day", weekday: "mon", week: 2, isDeload: false });
    if (day.kind !== "day") throw new Error("x");
    expect(day.items).toHaveLength(1);
    expect(day.items[0]?.swappedToday).toBeNull();
    expect(slugs(day)).toEqual(["squat", "hack_squat"]);
    expect(day.items[0]?.rirMin).toBe(2);
    expect(await planDayOn(db, "2026-12-21")).toEqual({
      kind: "finished",
      lastDate: "2026-12-20",
    });
  });

  it("v2 renders from its effective date only", async () => {
    const { planId, exId } = await setup();
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-20");
    const before = await planDayOn(db, "2026-10-19");
    const after = await planDayOn(db, "2026-10-20");
    const earlierTue = await planDayOn(db, "2026-10-13");
    if (before.kind !== "day" || after.kind !== "day" || earlierTue.kind !== "day") {
      throw new Error("x");
    }
    const v1 = (await versionOn(db, "2026-10-19"))?.versionId;
    const v2 = (await versionOn(db, "2026-10-20"))?.versionId;
    expect(v1).not.toBe(v2);
    expect(before.versionId).toBe(v1);
    expect(after.versionId).toBe(v2);
    expect(slugs(after)).toEqual(["ring_row"]);
    expect(slugs(earlierTue)).toEqual(["pullup"]);
    const idx = await loadVersionIndex(db);
    expect(idx.versionFor("2026-10-19")?.version).toBe(1);
    expect(idx.versionFor("2026-10-20")?.version).toBe(2);
    expect(idx.versionFor("2020-01-01")?.version).toBe(1);
    expect(idx.weekOf("2026-10-20")).toMatchObject({ week: 4, versionId: v2 });
    expect(idx.weekOf("2030-01-01")).toBeNull();
    expect(idx.fridayOf(4, "2026-10-20")).toBe("2026-10-23");
  });

  it("a deload insert makes 13 weeks", async () => {
    const { planId } = await setup();
    const base = await db.transaction((tx) => loadLatestContent(tx, planId));
    const ins = insertDeload(base.content, 6);
    await db.transaction((tx) =>
      createVersion(tx, {
        planId,
        baseVersionId: base.versionId,
        content: ins.content,
        effectiveFrom: "2026-11-02",
        reason: "deload",
        change: { kind: "deload_earlier", insertedWeek: 6, droppedWeek: ins.droppedWeek },
      }),
    );
    const w13 = await planDayOn(db, "2026-12-21");
    expect(w13).toMatchObject({ kind: "day", week: 13, weeksTotal: 13 });
    expect(await planDayOn(db, "2026-12-27")).toMatchObject({ kind: "rest", week: 13 });
    expect(await planDayOn(db, "2026-12-28")).toEqual({
      kind: "finished",
      lastDate: "2026-12-27",
    });
    // a date before the insert still renders under v1
    expect((await versionOn(db, "2026-10-26"))?.weeks).toBe(12);
    const idx = await loadVersionIndex(db);
    expect(idx.fridayOf(13, "2026-12-21")).toBe("2026-12-25");
  });

  it("planDaysBetween returns every date", async () => {
    await setup();
    const days = await planDaysBetween(db, "2026-10-05", "2026-10-11");
    expect(days.map((d) => d.kind)).toEqual(["day", "day", "day", "day", "day", "rest", "rest"]);
    expect(days).toHaveLength(7);
  });

  it("an override swaps one option on its date only", async () => {
    const { exId } = await setup();
    const hack = await exId("hack_squat");
    const press = await exId("leg_press");
    const id = await itemId("w05-mon-00-0");
    await sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values ('2026-10-26', ${id}, ${hack}, ${press})`;
    const day = await planDayOn(db, "2026-10-26");
    if (day.kind !== "day") throw new Error("x");
    expect(slugs(day)).toEqual(["squat", "leg_press"]);
    expect(day.items[0]?.swappedToday).toEqual({
      from: { id: hack, name: "Hack squat" },
      to: { id: press, name: "Leg press" },
    });
    expect(day.items[0]?.rirMin).toBe(1);
    expect(day.items[0]?.rirMax).toBe(3);
    expect(day.items[0]?.plannedItemId).toBe(id);
    const next = await planDayOn(db, "2026-11-02");
    expect(slugs(next)).toEqual(["squat", "hack_squat"]);
    expect(next.kind === "day" && next.items[0]?.swappedToday).toBeNull();
  });

  it("an override to an existing option is not listed twice", async () => {
    const { exId } = await setup();
    const id = await itemId("w05-mon-00-0");
    await sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values ('2026-10-26', ${id}, ${await exId("hack_squat")}, ${await exId("squat")})`;
    expect(slugs(await planDayOn(db, "2026-10-26"))).toEqual(["squat"]);
  });

  it("an override clears the HSPU step and uses deload RIR in a deload week", async () => {
    const { exId } = await setup();
    const [step] =
      await sql`insert into hspu_ladder (slug, name, step_order) values ('wall', 'Wall HSPU', 1) returning id`;
    const id = await itemId("w04-mon-00-0");
    await sql`update planned_items set hspu_step_id = ${step?.id as number} where id = ${id}`;
    const before = await planDayOn(db, "2026-10-19");
    if (before.kind !== "day") throw new Error("x");
    expect(before.items[0]?.hspuStepId).toBe(step?.id);
    await sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values ('2026-10-19', ${id}, ${await exId("hack_squat")}, ${await exId("leg_press")})`;
    const day = await planDayOn(db, "2026-10-19");
    if (day.kind !== "day") throw new Error("x");
    expect(day.items[0]?.hspuStepId).toBeNull();
    expect([day.items[0]?.rirMin, day.items[0]?.rirMax]).toEqual([3, 4]);
  });

  it("RIR follows the resulting option list and the week flag", async () => {
    const { exId } = await setup();
    const squat = await exId("squat");
    const hack = await exId("hack_squat");
    const press = await exId("leg_press");
    const pullup = await exId("pullup");
    await sql`update exercises set is_main_lift = true where id = ${squat}`;
    const ov = (date: string, id: number, from: number, to: number) =>
      sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values (${date}, ${id}, ${from}, ${to})`;
    const rir = async (date: string) => {
      const d = await planDayOn(db, date);
      if (d.kind !== "day") throw new Error("x");
      return [d.items[0]?.rirMin, d.items[0]?.rirMax];
    };
    // (a) single-option main lift replaced by a non-main weighted exercise
    const a = await itemId("w05-tue-00-0");
    await sql`update planned_item_options set exercise_id = ${squat} where planned_item_id = ${a}`;
    await ov("2026-10-27", a, squat, press);
    expect(await rir("2026-10-27")).toEqual([1, 3]);
    // (b) OR item keeps the main lift: stays 1-2
    const b = await itemId("w05-mon-00-0");
    await ov("2026-10-26", b, hack, press);
    expect(await rir("2026-10-26")).toEqual([1, 2]);
    // (c) deload week, no deload modifier: the week flag alone gives 3-4
    const c = await itemId("w04-tue-00-0");
    await sql`update planned_items set modifiers = '{}' where id = ${c}`;
    await ov("2026-10-20", c, pullup, press);
    expect(await rir("2026-10-20")).toEqual([3, 4]);
  });

  it("an override clears the fallback prescription for that date", async () => {
    const { exId } = await setup();
    const id = await itemId("w05-tue-00-0");
    await sql`update planned_items set fallback_prescription = '{"x":1}'::jsonb where id = ${id}`;
    const before = await planDayOn(db, "2026-10-27");
    if (before.kind !== "day") throw new Error("x");
    expect(before.items[0]?.fallback).not.toBeNull();
    await sql`insert into session_overrides (session_date, planned_item_id, replaced_exercise_id, replacement_exercise_id) values ('2026-10-27', ${id}, ${await exId("pullup")}, ${await exId("ring_row")})`;
    const after = await planDayOn(db, "2026-10-27");
    if (after.kind !== "day") throw new Error("x");
    expect(after.items[0]?.fallback).toBeNull();
  });

  it("a week straddling two versions renders each day under its own version", async () => {
    const { planId, exId } = await setup();
    await addSwapVersion(planId, await exId("pullup"), await exId("ring_row"), "2026-10-21");
    const days = await planDaysBetween(db, "2026-10-19", "2026-10-23");
    const v1 = (await versionOn(db, "2026-10-19"))?.versionId;
    const v2 = (await versionOn(db, "2026-10-21"))?.versionId;
    expect(v1).not.toBe(v2);
    expect(days.map((d) => (d.kind === "day" ? d.versionId : null))).toEqual([v1, v1, v2, v2, v2]);
    expect(slugs(days[1] as PlanDay)).toEqual(["pullup"]);
  });
});
