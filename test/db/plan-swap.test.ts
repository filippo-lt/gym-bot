import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { stageSwap } from "../../src/logging/resolve.js";
import { resolveSwap } from "../../src/plan/swap-stage.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table pending_actions, write_ledger, log_entries, log_groups, session_items, session_overrides, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  await seedPlan(db, fixture());
});

const START = "2026-09-28"; // Monday
const TODAY = "2026-10-19"; // Monday of week 4

function item(week: number, weekday: ParsedItem["weekday"], options: string[]): ParsedItem {
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
    prescription_raw: "3 × 15",
    extras_raw: null,
    sets_min: 3,
    sets_max: 3,
    reps_min: 15,
    reps_max: 15,
    per_side: false,
    duration_s_min: null,
    duration_s_max: null,
    hiit: null,
    tempo: null,
    modifiers: [],
    hspu_step: null,
    rir_min: null,
    rir_max: null,
    tags: [],
    rest_raw: "1 min",
    priority: "High",
    note: null,
    time_raw: "5 min",
    time_min_min: 5,
    time_min_max: 5,
    fallback_prescription: null,
    flags: [],
  };
}

function ex(slug: string, name: string): ResolvedPlan["plan"]["exercises"][number] {
  return {
    slug,
    name,
    aliases: [],
    muscle_group: "back",
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
    is_deload: false,
    is_test: false,
    start_date: addDays(START, 7 * i),
  }));
  const items = weeks.flatMap((w) => [
    item(w.week, "mon", ["face_pull"]),
    item(w.week, "tue", ["squat"]),
    item(w.week, "wed", ["pullup"]),
    item(w.week, "fri", ["squat"]),
  ]);
  return {
    open_issues: [],
    resolved_hash: "resolved-swap",
    plan: {
      source_hash: "hash-swap",
      name: "Swap Plan",
      start_date: START,
      weeks_count: 12,
      weeks,
      equipment: [
        {
          slug: "band",
          name: "Band",
          base_kg: null,
          step_kg: null,
          discrete_values: null,
          bands: null,
        },
      ],
      hspu_ladder: [
        {
          slug: "pike_push_up",
          name: "Pike push-up",
          order: 1,
          default_sets: 3,
          default_reps_min: 5,
          default_reps_max: 8,
          tempo: null,
        },
      ],
      exercises: [
        ex("face_pull", "Face pull"),
        ex("squat", "Squat"),
        ex("leg_press", "Leg press"),
        ex("pullup", "Pull-up"),
      ],
      items,
    },
  };
}

const swap = (over: Record<string, unknown> = {}) => ({
  exercise: { said: "face pull" },
  replacement: { said: "leg press" },
  ...over,
});

async function ok(input: Record<string, unknown>, today = TODAY) {
  const r = await resolveSwap(db, input as never, today);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reply}`);
  return r.resolved;
}
async function refused(input: Record<string, unknown>, today = TODAY) {
  const r = await resolveSwap(db, input as never, today);
  if (r.ok) throw new Error("expected a refusal");
  return r.reply;
}

describe("resolveSwap", () => {
  it("uses today when the exercise is in today's session", async () => {
    const r = await ok(swap({ scope: "today" }));
    expect(r.referenceDate).toBe(TODAY);
    expect(r.referenceWeekday).toBe("mon");
    expect(r.todayItemIds).toHaveLength(1);
    expect(r.loggedOnReference).toBe(false);
    expect(r.from.name).toBe("Face pull");
    expect(r.to).toMatchObject({
      name: "Leg press",
      slug: "leg_press",
      isNew: false,
      newSpec: null,
    });
    expect(r.prescription).toBe("3 × 15");
  });

  it("falls back to the next session that has the exercise, and lists future weekdays", async () => {
    const r = await ok(swap({ exercise: { said: "squat" }, replacement: { said: "leg press" } }));
    expect(r.referenceDate).toBe("2026-10-20");
    expect(r.referenceWeekday).toBe("tue");
    expect(r.futureWeekdays).toEqual(["tue", "fri"]);
    expect(r.scope).toBeNull();
    expect(r.days).toBeNull();
  });

  it("honours a named day", async () => {
    const r = await ok(
      swap({ exercise: { said: "squat" }, replacement: { said: "leg press" }, day: "fri" }),
    );
    expect(r.referenceDate).toBe("2026-10-23");
    expect(r.referenceWeekday).toBe("fri");
  });

  it("sets days to this_day when only one weekday is left", async () => {
    const r = await ok(swap({ scope: "rest" }));
    expect(r.futureWeekdays).toEqual(["mon"]);
    expect(r.days).toBe("this_day");
  });

  it("counts future sessions from the effective date", async () => {
    // Mondays of weeks 5..12 (effective from tomorrow, the 20th).
    const face = await ok(swap({ scope: "rest" }));
    expect(face.affectedSessions).toBe(8);
    // Tue + Fri of weeks 4..12.
    const sq = await ok(
      swap({ exercise: { said: "squat" }, replacement: { said: "leg press" }, scope: "rest" }),
    );
    expect(sq.affectedSessions).toBe(18);
    expect(sq.sessionsByWeekday).toEqual({ tue: 9, fri: 9 });
    const tueOnly = await ok(
      swap({
        exercise: { said: "squat" },
        replacement: { said: "leg press" },
        scope: "rest",
        days: "this_day",
      }),
    );
    expect(tueOnly.affectedSessions).toBe(9);
  });

  it("flags an exercise already logged on the reference day", async () => {
    const [face] = await sql`select id from exercises where slug = 'face_pull'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source) values (${TODAY}, now(), ${face?.id}, 'text')`;
    const r = await ok(swap({ scope: "today" }));
    expect(r.loggedOnReference).toBe(true);
  });

  it("replies when the exercise is not in the plan from today on", async () => {
    await sql`insert into exercises (slug, name, muscle_group, type, is_main_lift) values ('ring_row', 'Ring row', 'back', 'weighted', false)`;
    expect(await refused(swap({ exercise: { said: "ring row" } }))).toContain(
      "isn't in the plan from today on",
    );
  });

  it("replies when the exercise is the same", async () => {
    expect(await refused(swap({ replacement: { said: "face pull" } }))).toContain("same");
  });

  it("replies when the exercise cannot be told", async () => {
    expect(await refused(swap({ exercise: { said: "zzzz" } }))).toContain("Which exercise");
  });

  it("does not plan an HSPU ladder step as a replacement", async () => {
    for (const rep of [{ said: "pike push-up" }, { said: "something", slug: "pike_push_up" }]) {
      expect(await refused(swap({ replacement: rep }))).toContain("HSPU");
    }
  });

  it("a catalog exercise wins over a `new` spec", async () => {
    const r = await ok(
      swap({
        replacement: {
          said: "leg press",
          new: { name: "Leg press", type: "weighted", muscle_group: "legs" },
        },
      }),
    );
    expect(r.to.isNew).toBe(false);
    expect(r.to.id).not.toBeNull();
  });

  it("refuses a `new` exercise whose name is an HSPU step", async () => {
    const reply = await refused(
      swap({
        replacement: {
          said: "my favourite",
          new: { name: "Pike push-up", type: "bodyweight_reps", muscle_group: "shoulders" },
        },
      }),
    );
    expect(reply).toContain("HSPU");
    const r = await stageSwap(
      db,
      swap({
        replacement: {
          said: "my favourite",
          new: { name: "Pike push up", type: "bodyweight_reps", muscle_group: "shoulders" },
        },
      }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    expect(r.ok).toBe(false);
  });

  it("a slug-only replacement resolves to the catalog exercise", async () => {
    const r = await ok(
      swap({
        replacement: {
          said: "zxq press",
          slug: "leg_press",
          new: { name: "Leg press x", type: "weighted", muscle_group: "legs" },
        },
      }),
    );
    expect(r.to).toMatchObject({ slug: "leg_press", isNew: false, newSpec: null });
  });

  it("builds a new exercise from `new`", async () => {
    const r = await ok(
      swap({
        replacement: {
          said: "band pull apart",
          new: {
            name: "Band pull-apart",
            type: "bodyweight_reps",
            muscle_group: "back",
            equipment_slug: "band",
          },
        },
      }),
    );
    expect(r.to).toEqual({
      id: null,
      name: "Band pull-apart",
      slug: "band_pull_apart",
      isNew: true,
      newSpec: {
        type: "bodyweight_reps",
        loadBasis: null,
        equipmentSlug: "band",
        muscleGroup: "back",
      },
    });
  });

  it("refuses an unknown equipment slug", async () => {
    const reply = await refused(
      swap({
        replacement: {
          said: "band pull apart",
          new: {
            name: "Band pull-apart",
            type: "bodyweight_reps",
            muscle_group: "back",
            equipment_slug: "rocket",
          },
        },
      }),
    );
    expect(reply).toContain("describe");
  });

  it("asks which exercise when the replacement is unknown and no `new` is given", async () => {
    expect(await refused(swap({ replacement: { said: "flurble" } }))).toContain("describe");
  });
});

describe("stageSwap", () => {
  it("returns a staged swap action", async () => {
    const r = await stageSwap(
      db,
      swap({ scope: "today" }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.action.kind).toBe("swap");
    expect(r.preview).toContain("Do not repeat");
  });
  it("turns a refusal into a tool error", async () => {
    const r = await stageSwap(
      db,
      swap({ replacement: { said: "face pull" } }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    expect(r.ok).toBe(false);
  });
});
