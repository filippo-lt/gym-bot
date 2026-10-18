import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import type { CatalogExercise, ParsedItem } from "../../src/plan-import/types.js";
import { planFixture } from "../history-import/plan-fixture.js";
import { testDatabaseUrl } from "./constants.js";

export function connect() {
  const sql = postgres(testDatabaseUrl(), { max: 4, prepare: false, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

export type TestDb = ReturnType<typeof connect>["db"];

/** Mon 2026-09-28 (week 1) 10:00 Rome. */
export const MON = new Date("2026-09-28T08:00:00Z");
/** Tue 2026-09-29 10:00 Rome. */
export const TUE = new Date("2026-09-29T08:00:00Z");
/** Sat 2026-10-03 10:00 Rome. */
export const SAT = new Date("2026-10-03T08:00:00Z");

const extraExercises: CatalogExercise[] = [
  {
    slug: "hspu",
    name: "HSPU",
    aliases: [],
    muscle_group: "shoulders",
    type: "skill_ladder",
    load_basis: null,
    equipment_slug: null,
    is_main_lift: false,
    review_note: null,
  },
  {
    slug: "face_pull",
    name: "Face pull",
    aliases: ["face pulls"],
    muscle_group: "rear delts",
    type: "weighted",
    load_basis: "stack",
    equipment_slug: "cable_stack",
    is_main_lift: false,
    review_note: null,
  },
];

export const LADDER = ["hspu_negative", "partial_rom_wall_hspu", "full_wall_hspu"].map(
  (slug, i) => ({
    slug,
    name: slug,
    order: i + 1,
    default_sets: 3,
    default_reps_min: 3,
    default_reps_max: 3,
    tempo: null,
  }),
);

export async function resetAndSeed(db: TestDb, sql: postgres.Sql): Promise<void> {
  await sql`truncate table write_ledger, pending_actions, memory_items, conversation_messages, usage_logs, log_entries, log_groups, session_items, class_logs, weekly_metrics, bodyweight_logs, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  const resolved = planFixture();
  resolved.plan.exercises.push(...extraExercises);
  resolved.plan.hspu_ladder = LADDER;
  const base = resolved.plan.items.find((i) => i.key === "w01-tue-00-0") as ParsedItem;
  for (const week of [1, 2, 3]) {
    const pad = `w0${week}`;
    const tue = resolved.plan.items.find((i) => i.key === `${pad}-tue-00-0`) as ParsedItem;
    resolved.plan.items.push({
      ...base,
      key: `${pad}-tue-01-0`,
      week,
      order: 1,
      plan_name: "HSPU progression",
      exercise_options: ["hspu"],
      hspu_step: "hspu_negative",
      sets_min: 3,
      sets_max: 3,
      reps_min: 3,
      reps_max: 3,
    });
    void tue;
  }
  await seedPlan(db, resolved);
}

export async function exId(sql: postgres.Sql, slug: string): Promise<number> {
  const [r] = await sql`select id from exercises where slug = ${slug}`;
  return r?.id as number;
}
