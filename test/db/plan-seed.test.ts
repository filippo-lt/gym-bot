import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { OpenIssuesError, SeedConflictError, seedPlan } from "../../src/db/seed-plan.js";
import {
  applyOverrides,
  buildPlan,
  type ItemOverride,
  loadEquipment,
  loadHspuLadder,
  loadOverrides,
  OR_PLAN_NAMES,
  readPlanFile,
} from "../../src/plan-import/index.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { assertSafeTestDatabaseUrl, testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
});

function item(
  over: Partial<ParsedItem> & Pick<ParsedItem, "key" | "week" | "weekday" | "order">,
): ParsedItem {
  return {
    sub_item: 0,
    block: "Main",
    plan_name: "Squat",
    exercise_options: ["squat"],
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
    modifiers: [],
    hspu_step: null,
    rir_min: 2,
    rir_max: 3,
    tags: ["squat"],
    rest_raw: "2-3 min",
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

function fixture(
  over: { hash?: string; issues?: ResolvedPlan["open_issues"]; stepKg?: number | null } = {},
): ResolvedPlan {
  return {
    open_issues: over.issues ?? [],
    resolved_hash: "resolved-a",
    plan: {
      source_hash: over.hash ?? "hash-a",
      name: "Test Plan",
      start_date: "2026-09-28",
      weeks_count: 2,
      weeks: [
        { week: 1, phase: "Base", is_deload: false, is_test: false, start_date: "2026-09-28" },
        { week: 2, phase: "Base", is_deload: true, is_test: false, start_date: "2026-10-05" },
      ],
      equipment: [
        {
          slug: "barbell",
          name: "Barbell",
          base_kg: 20,
          step_kg: over.stepKg === undefined ? 2.5 : over.stepKg,
          discrete_values: null,
          bands: null,
        },
        {
          slug: "bands",
          name: "Bands",
          base_kg: null,
          step_kg: null,
          discrete_values: null,
          bands: { red: 10, blue: 20 },
        },
        {
          slug: "hack_machine",
          name: "Hack squat machine",
          base_kg: null,
          step_kg: null,
          discrete_values: [10, 20, 30],
          bands: null,
        },
      ],
      hspu_ladder: [
        {
          slug: "pike",
          name: "Pike HSPU",
          order: 1,
          default_sets: 3,
          default_reps_min: 5,
          default_reps_max: 8,
          tempo: "3-1-1",
        },
        {
          slug: "wall",
          name: "Wall HSPU",
          order: 2,
          default_sets: null,
          default_reps_min: null,
          default_reps_max: null,
          tempo: null,
        },
      ],
      exercises: [
        {
          slug: "squat",
          name: "Squat",
          aliases: ["back squat"],
          muscle_group: "legs",
          type: "weighted",
          load_basis: "barbell_total",
          equipment_slug: "barbell",
          is_main_lift: true,
          review_note: null,
        },
        {
          slug: "hack_squat",
          name: "Hack squat",
          aliases: [],
          muscle_group: "legs",
          type: "weighted",
          load_basis: "stack",
          equipment_slug: "hack_machine",
          is_main_lift: false,
          review_note: null,
        },
        {
          slug: "pullup",
          name: "Weighted pull-up",
          aliases: [],
          muscle_group: "back",
          type: "bodyweight_plus",
          load_basis: "bodyweight_plus",
          equipment_slug: "bands",
          is_main_lift: true,
          review_note: null,
        },
        {
          slug: "hspu",
          name: "HSPU",
          aliases: [],
          muscle_group: "shoulders",
          type: "skill_ladder",
          load_basis: null,
          equipment_slug: null,
          is_main_lift: true,
          review_note: null,
        },
      ],
      items: [
        item({
          key: "w01-tue-00-0",
          week: 1,
          weekday: "tue",
          order: 0,
          plan_name: "Squat / hack squat",
          exercise_options: ["squat", "hack_squat"],
        }),
        item({
          key: "w01-mon-00-0",
          week: 1,
          weekday: "mon",
          order: 0,
          plan_name: "Weighted pull-up",
          exercise_options: ["pullup"],
          tags: ["vertical_pull"],
          fallback_prescription: {
            if_bw_max_gte: 1,
            // biome-ignore lint/suspicious/noThenProperty: field name is fixed by the FallbackPrescription contract
            then: { mode: "bodyweight", sets: 4, reps_min: 4, reps_max: 6 },
            else: { mode: "assisted", sets: 4, reps_min: 4, reps_max: 6 },
          },
        }),
        item({
          key: "w01-tue-01-0",
          week: 1,
          weekday: "tue",
          order: 1,
          plan_name: "HSPU",
          exercise_options: ["hspu"],
          hspu_step: "pike",
          tags: ["vertical_press"],
          modifiers: ["easy"],
        }),
        item({
          key: "w02-mon-00-0",
          week: 2,
          weekday: "mon",
          order: 0,
          plan_name: "Weighted pull-up",
          exercise_options: ["pullup"],
          tags: ["vertical_pull"],
          modifiers: ["deload"],
        }),
        item({
          key: "w02-mon-00-1",
          week: 2,
          weekday: "mon",
          order: 0,
          sub_item: 1,
          plan_name: "Weighted pull-up",
          exercise_options: ["pullup"],
          extras_raw: "+ 1 easy BW set",
          tags: ["vertical_pull"],
        }),
      ],
    },
  };
}

async function counts() {
  const rows = await sql`
    select
      (select count(*)::int from equipment) as equipment,
      (select count(*)::int from exercises) as exercises,
      (select count(*)::int from hspu_ladder) as ladder,
      (select count(*)::int from plans) as plans,
      (select count(*)::int from plan_versions) as versions,
      (select count(*)::int from plan_weeks) as weeks,
      (select count(*)::int from planned_items) as items,
      (select count(*)::int from planned_item_options) as options`;
  return rows[0];
}

describe("seedPlan", () => {
  it("inserts, then is a no-op the second time", async () => {
    const first = await seedPlan(db, fixture());
    expect(first).toEqual({
      equipment: 3,
      exercises: 4,
      ladder: 2,
      weeks: 2,
      items: 5,
      options: 6,
      action: "inserted",
    });
    const before = await counts();
    expect(before).toMatchObject({ plans: 1, versions: 1, weeks: 2, items: 5, options: 6 });

    const second = await seedPlan(db, fixture());
    expect(second.action).toBe("unchanged");
    expect(await counts()).toEqual(before);
  });

  it("refuses when there are open issues and writes nothing", async () => {
    const issues = [{ scope: "item" as const, ref: "w01-mon-00-0", detail: "unparsed" }];
    await expect(seedPlan(db, fixture({ issues }))).rejects.toBeInstanceOf(OpenIssuesError);
    expect(await counts()).toMatchObject({ equipment: 0, exercises: 0, plans: 0, items: 0 });
  });

  it("refuses the same plan name with a different source hash", async () => {
    await seedPlan(db, fixture());
    const before = await counts();
    await expect(seedPlan(db, fixture({ hash: "hash-b" }))).rejects.toBeInstanceOf(
      SeedConflictError,
    );
    expect(await counts()).toEqual(before);
  });

  it("stores OR items as two option rows with distinct exercises", async () => {
    await seedPlan(db, fixture());
    const rows = await sql`
      select o.option_index, e.slug, e.id
      from planned_item_options o
      join planned_items i on i.id = o.planned_item_id
      join exercises e on e.id = o.exercise_id
      where i.item_key = 'w01-tue-00-0'
      order by o.option_index`;
    expect(rows.map((r) => r.slug)).toEqual(["squat", "hack_squat"]);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it("maps hspu step, fallback prescription and numeric columns", async () => {
    await seedPlan(db, fixture());
    const [hspu] =
      await sql`select l.slug, i.rir_min from planned_items i join hspu_ladder l on l.id = i.hspu_step_id where i.item_key = 'w01-tue-01-0'`;
    expect(hspu).toMatchObject({ slug: "pike" });
    const [pull] =
      await sql`select fallback_prescription as f from planned_items where item_key = 'w01-mon-00-0'`;
    const fallback = pull?.f as { then: { mode: string } };
    expect(fallback.then.mode).toBe("bodyweight");
  });

  it("rejects an unknown option slug and rolls back", async () => {
    const f = fixture();
    f.plan.items[0] = { ...(f.plan.items[0] as ParsedItem), exercise_options: ["nope"] };
    await expect(seedPlan(db, f)).rejects.toThrow(/Unknown exercise slug "nope"/);
    expect(await counts()).toMatchObject({ plans: 0, exercises: 0 });
  });

  it("dry run writes nothing", async () => {
    const summary = await seedPlan(db, fixture(), { dryRun: true });
    expect(summary.action).toBe("inserted");
    expect(await counts()).toMatchObject({ equipment: 0, plans: 0, items: 0 });
  });

  it("re-seeds changed equipment values without touching plan rows", async () => {
    await seedPlan(db, fixture());
    const before = await counts();
    const summary = await seedPlan(db, fixture({ stepKg: 5 }));
    expect(summary.action).toBe("unchanged");
    expect(await counts()).toEqual(before);
    const [row] = await sql`select step_kg::float as s from equipment where slug = 'barbell'`;
    expect(row?.s).toBe(5);
  });
});

describe("seedPlan re-runs and refusals (fixture)", () => {
  it("refuses items that still carry flags even when open_issues is empty", async () => {
    const f = fixture();
    const first = f.plan.items[0] as ParsedItem;
    f.plan.items[0] = { ...first, flags: [{ code: "missing_reps", detail: "no reps" }] };
    await expect(seedPlan(db, f)).rejects.toBeInstanceOf(OpenIssuesError);
    expect(await counts()).toMatchObject({ plans: 0, items: 0 });
  });

  it("refuses same source_hash with a changed item (resolved_hash differs)", async () => {
    await seedPlan(db, fixture());
    const before = await counts();
    const changed = fixture();
    changed.resolved_hash = "resolved-b";
    const first = changed.plan.items[0] as ParsedItem;
    changed.plan.items[0] = { ...first, reps_min: 6, reps_max: 6 };
    await expect(seedPlan(db, changed)).rejects.toThrow(/plan versions in M7/);
    await expect(seedPlan(db, changed)).rejects.toBeInstanceOf(SeedConflictError);
    expect(await counts()).toEqual(before);
  });

  it("allows an equipment-only change and updates equipment", async () => {
    await seedPlan(db, fixture());
    const changed = fixture({ stepKg: 5 });
    const bar = changed.plan.equipment.find((e) => e.slug === "barbell");
    if (bar) bar.base_kg = 20;
    const summary = await seedPlan(db, changed);
    expect(summary.action).toBe("unchanged");
    const [row] =
      await sql`select step_kg::float as s, base_kg::float as b from equipment where slug = 'barbell'`;
    expect(row).toEqual({ s: 5, b: 20 });
  });

  it("re-seed keeps band kg set by the user and only fills missing colours", async () => {
    await seedPlan(db, fixture());
    await sql`update equipment set bands = ${JSON.stringify({ red: 15, green: 30 })}::jsonb where slug = 'bands'`;
    await seedPlan(db, fixture());
    const [row] = await sql`select bands from equipment where slug = 'bands'`;
    // red keeps the user's 15 (seed says 10), green survives, blue is filled from the seed
    expect(row?.bands).toEqual({ red: 15, green: 30, blue: 20 });
    // equipment without bands in the seed keeps its (null) bands
    const [bar] = await sql`select bands from equipment where slug = 'barbell'`;
    expect(bar?.bands).toBeNull();
  });
});

describe("test database guard", () => {
  it("rejects non-local hosts and non-_test names", () => {
    expect(() => assertSafeTestDatabaseUrl("postgres://u:p@db.example.com:5432/x_test")).toThrow();
    expect(() => assertSafeTestDatabaseUrl("postgres://u:p@localhost:5432/gymbot")).toThrow();
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://u:p@127.0.0.1:5432/gymbot_test"),
    ).not.toThrow();
  });
});

describe("row level security", () => {
  it("is enabled on every table in schema public", async () => {
    const rows = await sql`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });
});

describe("real plan pipeline", () => {
  const rawPlan = readPlanFile("seed/hybrid-strength-plan.json");
  const equipment = loadEquipment("seed/equipment.json");
  const ladder = loadHspuLadder("seed/hspu-ladder.json");

  it("the reviewed seed files resolve clean; unresolved flags make seedPlan refuse", async () => {
    const plan = buildPlan(rawPlan, { equipment, hspuLadder: ladder });
    const reviewed = applyOverrides(plan, loadOverrides("seed/plan-overrides.json"));
    expect(reviewed.open_issues).toEqual([]);

    const unresolved = applyOverrides(plan, { source_hash: plan.source_hash, items: {} });
    expect(unresolved.open_issues.length).toBeGreaterThan(0);
    await expect(seedPlan(db, unresolved)).rejects.toBeInstanceOf(OpenIssuesError);
    expect(await counts()).toMatchObject({ plans: 0, items: 0, equipment: 0 });
  });

  function resolvedCopy() {
    const plan = buildPlan(rawPlan, {
      equipment: equipment.map((e) => ({
        ...e,
        base_kg: e.base_kg ?? (e.slug === "barbell" ? 20 : null),
        bands: e.slug === "pullup" ? (e.bands ?? { red: 10, blue: 20 }) : e.bands,
        step_kg: e.step_kg === null && e.discrete_values === null ? 2.5 : e.step_kg,
      })),
      hspuLadder: ladder.map((h) => ({
        ...h,
        default_sets: h.default_sets ?? 3,
        default_reps_min: h.default_reps_min ?? 3,
        default_reps_max: h.default_reps_max ?? 5,
      })),
    });
    plan.exercises = plan.exercises.map((e) => ({ ...e, review_note: null }));
    const items: Record<string, ItemOverride> = {};
    for (const it of plan.items) {
      if (it.flags.length === 0) continue;
      items[it.key] = {
        resolve: it.flags.map((f) => f.code),
        ...(it.sets_min === null ? { sets_min: 3, sets_max: 3 } : {}),
        ...(it.reps_min === null ? { reps_min: 8, reps_max: 8 } : {}),
      };
    }
    return applyOverrides(plan, { source_hash: plan.source_hash, items });
  }

  it("seeds the full plan once and is idempotent", async () => {
    const resolved = resolvedCopy();
    expect(resolved.open_issues).toEqual([]);
    const plan = resolved.plan;

    const first = await seedPlan(db, resolved);
    expect(first.action).toBe("inserted");
    const c = await counts();
    expect(c).toMatchObject({
      plans: 1,
      versions: 1,
      weeks: 12,
      items: 323,
      exercises: plan.exercises.length,
    });

    const orNames = new Set<string>(OR_PLAN_NAMES);
    const optionCounts = await sql`
      select i.plan_name, i.item_key, count(o.*)::int as n
      from planned_items i left join planned_item_options o on o.planned_item_id = i.id
      group by i.id, i.plan_name, i.item_key`;
    for (const r of optionCounts) {
      expect(r.n, `${r.item_key} (${r.plan_name})`).toBe(orNames.has(r.plan_name) ? 2 : 1);
    }
    expect(optionCounts.some((r) => orNames.has(r.plan_name))).toBe(true);

    const pullups = await sql`
      select i.item_key, i.fallback_prescription is not null as has_fb
      from planned_items i
      join planned_item_options o on o.planned_item_id = i.id
      join exercises e on e.id = o.exercise_id
      where e.slug like '%pull%up%' and e.type = 'bodyweight_plus'`;
    expect(pullups.length).toBeGreaterThan(0);
    expect(pullups.filter((r) => !r.has_fb).map((r) => r.item_key)).toEqual([]);

    const second = await seedPlan(db, resolvedCopy());
    expect(second.action).toBe("unchanged");
    expect(await counts()).toEqual(c);
  });
});
