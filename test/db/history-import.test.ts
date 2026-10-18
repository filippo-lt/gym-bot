import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HistoryOpenIssuesError, importHistory } from "../../src/db/import-history.js";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { buildHistoryImport, hashExport } from "../../src/history-import/index.js";
import {
  EQUIPMENT,
  GOOD_OVERRIDES,
  PLAN_NAME,
  planFixture,
} from "../history-import/plan-fixture.js";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });
const RAW = readFileSync("test/fixtures/history-export.json", "utf8");
const opts = { planName: PLAN_NAME, equipment: EQUIPMENT };

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table log_entries, log_groups, session_items, class_logs, weekly_metrics, bodyweight_logs, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  await seedPlan(db, planFixture());
});

function build(records: Record<string, unknown> = GOOD_OVERRIDES.records) {
  return buildHistoryImport(RAW, planFixture(), EQUIPMENT, {
    export_hash: hashExport(RAW),
    bodyweight: GOOD_OVERRIDES.bodyweight,
    records,
  });
}

async function counts() {
  const [r] = await sql`
    select
      (select count(*)::int from session_items) as session_items,
      (select count(*)::int from log_groups) as log_groups,
      (select count(*)::int from log_entries) as log_entries,
      (select count(*)::int from class_logs) as class_logs,
      (select count(*)::int from weekly_metrics) as weekly_metrics,
      (select count(*)::int from bodyweight_logs) as bodyweight_logs`;
  return r;
}

describe("importHistory", () => {
  it("imports twice with identical counts", async () => {
    const first = await importHistory(db, build(), opts);
    expect(first.inserted.log_groups).toBe(8);
    const c1 = await counts();
    expect(c1).toMatchObject({
      session_items: 14,
      class_logs: 2,
      weekly_metrics: 7,
      bodyweight_logs: 1,
    });
    const second = await importHistory(db, build(), opts);
    expect(second.deleted.log_groups).toBe(8);
    expect(await counts()).toEqual(c1);
  });

  it("keeps bot rows on re-import and reports the clash", async () => {
    await importHistory(db, build(), opts);
    await sql`delete from session_items where import_row_key = '2026-09-28/Bench press/3'`;
    const [bench] = await sql`select id from planned_items where item_key = 'w01-mon-03-0'`;
    const [sq] = await sql`select id from exercises where slug = 'squat'`;
    await sql`insert into session_items (session_date, planned_item_id, status, source) values ('2026-09-28', ${bench?.id}, 'done', 'bot')`;
    await sql`insert into log_groups (session_date, performed_at, planned_item_id, exercise_id, source) values ('2026-09-28', now(), ${bench?.id}, ${sq?.id}, 'text')`;
    const botDate = (
      await sql`select count(*)::int as n from class_logs where date = '2026-10-01'`
    )[0];
    expect(botDate?.n).toBe(1);

    const summary = await importHistory(db, build(), opts);
    expect(summary.clashes.some((c) => c.includes("Bench press"))).toBe(true);
    const [bot] = await sql`select count(*)::int as n from session_items where source = 'bot'`;
    expect(bot?.n).toBe(1);
    const [grp] = await sql`select count(*)::int as n from log_groups where source = 'text'`;
    expect(grp?.n).toBe(1);
    const [bench2] =
      await sql`select count(*)::int as n from session_items where planned_item_id = ${bench?.id}`;
    expect(bench2?.n).toBe(1);
  });

  it("never touches non-import class, metric and bodyweight rows", async () => {
    await sql`insert into class_logs (date, source) values ('2026-10-01', 'bot')`;
    await sql`insert into weekly_metrics (plan_week, metric, value_num, source) values (1, 'pullups', 9, 'bot')`;
    await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 68, 'bot')`;
    const summary = await importHistory(db, build(), opts);
    expect(summary.clashes.length).toBe(3);
    const [m] =
      await sql`select value_num::float as v, source from weekly_metrics where plan_week = 1 and metric = 'pullups'`;
    expect(m).toEqual({ v: 9, source: "bot" });
    const [b] = await sql`select kg::float as kg from bodyweight_logs`;
    expect(b?.kg).toBe(68);
  });

  it("a hack_squat group never lands on the squat exercise id", async () => {
    await importHistory(db, build(), opts);
    const rows = await sql`
      select e.slug from log_groups g join exercises e on e.id = g.exercise_id
      where g.import_row_key = '2026-09-28/Squat / hack squat/4'`;
    expect(rows.map((r) => r.slug)).toEqual(["hack_squat"]);
    const [n] =
      await sql`select count(*)::int as n from log_groups g join exercises e on e.id = g.exercise_id where e.slug = 'squat'`;
    expect(n?.n).toBe(0);
  });

  it("stores converted numbers", async () => {
    await importHistory(db, build(), opts);
    const rows = await sql`
      select e.set_index, e.reps, e.load_kg::float as load_kg, e.rir::float as rir, e.rir_plus
      from log_entries e join log_groups g on g.id = e.group_id
      where g.import_row_key = '2026-09-28/Bench press/3' order by e.set_index`;
    expect(rows).toEqual([
      { set_index: 1, reps: 7, load_kg: 65, rir: null, rir_plus: false },
      { set_index: 2, reps: 7, load_kg: 65, rir: 4, rir_plus: true },
    ]);
  });

  it("refuses on open issues and writes nothing", async () => {
    const withIssue = build({});
    expect(withIssue.open_issues.length).toBeGreaterThan(0);
    await expect(importHistory(db, withIssue, opts)).rejects.toBeInstanceOf(HistoryOpenIssuesError);
    expect(await counts()).toEqual({
      session_items: 0,
      log_groups: 0,
      log_entries: 0,
      class_logs: 0,
      weekly_metrics: 0,
      bodyweight_logs: 0,
    });
  });

  it("dry run writes nothing", async () => {
    const s = await importHistory(db, build(), { ...opts, dryRun: true });
    expect(s.dryRun).toBe(true);
    expect((await counts())?.log_groups).toBe(0);
  });

  it("refuses when equipment base_kg in the DB is stale, and writes nothing", async () => {
    const eq = EQUIPMENT.map((e) => (e.slug === "barbell" ? { ...e, base_kg: 20 } : e));
    await expect(
      importHistory(db, build(), { planName: PLAN_NAME, equipment: eq }),
    ).rejects.toThrow(/pnpm plan:seed first/);
    expect((await counts())?.log_groups).toBe(0);
    const [row] = await sql`select base_kg::float as b from equipment where slug = 'barbell'`;
    expect(row?.b).toBe(15);
  });
});

describe("row level security (log tables)", () => {
  it("is enabled on every table", async () => {
    const rows = await sql`
      select c.relname, c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname in ('session_items','log_groups','log_entries','class_logs','weekly_metrics','bodyweight_logs')`;
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });
});
