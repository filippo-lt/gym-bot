import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { insertDeload } from "../../src/plan/deload.js";
import { applySwap } from "../../src/plan/swap-transform.js";
import {
  createVersion,
  loadLatestContent,
  StaleBaseVersionError,
} from "../../src/plan/versions.js";
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
      ],
      items,
    },
  };
}

async function snapshot(versionId: number) {
  return sql`
    select i.*, (select coalesce(json_agg(o order by o.option_index), '[]'::json)
      from planned_item_options o where o.planned_item_id = i.id) as opts
    from planned_items i where i.plan_version_id = ${versionId} order by i.id`;
}

async function setup() {
  await seedPlan(db, fixture());
  const [plan] = await sql`select id from plans`;
  const planId = plan?.id as number;
  const base = await db.transaction((tx) => loadLatestContent(tx, planId));
  const exId = async (slug: string) =>
    (await sql`select id from exercises where slug = ${slug}`)[0]?.id as number;
  return { planId, base, exId };
}

const keepRir = (i: { rirMin: number | null; rirMax: number | null }) => ({
  rirMin: i.rirMin,
  rirMax: i.rirMax,
});

describe("createVersion", () => {
  it("copies a swap as version 2 and leaves version 1 untouched", async () => {
    const { planId, base, exId } = await setup();
    const hack = await exId("hack_squat");
    const press = await exId("leg_press");
    const v1Before = await snapshot(base.versionId);
    const logBefore =
      await sql`select (select count(*)::int from log_groups) a, (select count(*)::int from session_items) b`;
    const fromDate = "2026-11-02"; // Monday of week 6
    const { content } = applySwap(base.content, {
      fromExerciseId: hack,
      toExerciseId: press,
      fromDate,
      weekdays: "all",
      clearHspuStep: false,
      rirFor: (i) => keepRir(i),
    });
    const res = await db.transaction((tx) =>
      createVersion(tx, {
        planId,
        baseVersionId: base.versionId,
        content,
        effectiveFrom: fromDate,
        reason: "swap",
        change: { kind: "swap", from: hack, to: press, weekdays: "all", fromDate },
      }),
    );
    expect(res.version).toBe(2);
    const v2 = await db.transaction((tx) => loadLatestContent(tx, planId));
    expect(v2.version).toBe(2);
    expect(v2.content.items).toHaveLength(base.content.items.length);
    expect(v2.content.weeks).toHaveLength(12);
    expect(new Set(v2.content.items.map((i) => i.itemKey))).toEqual(
      new Set(base.content.items.map((i) => i.itemKey)),
    );
    const before = v2.content.items.find((i) => i.itemKey === "w05-mon-00-0");
    const after = v2.content.items.find((i) => i.itemKey === "w06-mon-00-0");
    expect(before?.optionExerciseIds).toContain(hack);
    expect(after?.optionExerciseIds).toEqual([await exId("squat"), press]);
    const [pv] = await sql`select * from plan_versions where id = ${res.versionId}`;
    expect(pv).toMatchObject({
      reason: "swap",
      source_hash: "hash-a",
      resolved_hash: "resolved-a",
      change: { kind: "swap", from: hack, to: press },
    });
    expect(await snapshot(base.versionId)).toEqual(v1Before);
    expect(
      await sql`select (select count(*)::int from log_groups) a, (select count(*)::int from session_items) b`,
    ).toEqual(logBefore);
  });

  it("a deload insert gives 13 weeks", async () => {
    const { planId, base } = await setup();
    const ins = insertDeload(base.content, 6);
    const res = await db.transaction((tx) =>
      createVersion(tx, {
        planId,
        baseVersionId: base.versionId,
        content: ins.content,
        effectiveFrom: "2026-11-02",
        reason: "deload",
        change: { kind: "deload_earlier", insertedWeek: 6, droppedWeek: ins.droppedWeek },
      }),
    );
    const [w] =
      await sql`select count(*)::int n from plan_weeks where plan_version_id = ${res.versionId}`;
    expect(w?.n).toBe(13);
    expect(
      (
        await sql`select count(*)::int n from plan_weeks where plan_version_id = ${base.versionId}`
      )[0]?.n,
    ).toBe(12);
  });

  it("rejects a stale base version", async () => {
    const { planId, base } = await setup();
    const args = {
      planId,
      baseVersionId: base.versionId,
      content: base.content,
      effectiveFrom: "2026-11-02",
      reason: "noop",
      change: { kind: "deload_earlier", insertedWeek: 6, droppedWeek: null } as const,
    };
    await db.transaction((tx) => createVersion(tx, args));
    await expect(db.transaction((tx) => createVersion(tx, args))).rejects.toBeInstanceOf(
      StaleBaseVersionError,
    );
    expect((await sql`select count(*)::int n from plan_versions`)[0]?.n).toBe(2);
  });
});
