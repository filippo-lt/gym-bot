import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import { executeActions } from "../../src/logging/execute.js";
import { createPending } from "../../src/logging/pending.js";
import { stageSwap } from "../../src/logging/resolve.js";
import type { ResolvedSwap, StagedAction } from "../../src/logging/types.js";
import { planDayOn } from "../../src/plan/effective.js";
import { executeSwap } from "../../src/plan/swap-execute.js";
import { resolveSwap } from "../../src/plan/swap-stage.js";
import { undoPlanChange } from "../../src/plan/undo.js";
import { addDays } from "../../src/plan-import/build-plan.js";
import type { ParsedItem, ResolvedPlan } from "../../src/plan-import/types.js";
import { testDatabaseUrl } from "./constants.js";

const race = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/plan/versions.js", async (orig) => {
  const real = await orig<typeof import("../../src/plan/versions.js")>();
  return {
    ...real,
    // A competing writer takes the next version number between the read and our insert.
    createVersion: async (tx: never, args: Parameters<typeof real.createVersion>[1]) => {
      if (race.on) {
        const t = tx as Parameters<typeof real.createVersion>[0];
        const [latest] = await t
          .select()
          .from(schema.planVersions)
          .orderBy(desc(schema.planVersions.version))
          .limit(1);
        await t.insert(schema.planVersions).values({
          planId: args.planId,
          version: (latest?.version ?? 0) + 1,
          effectiveFrom: args.effectiveFrom,
          reason: "other",
          sourceHash: latest?.sourceHash ?? "",
          resolvedHash: latest?.resolvedHash ?? "",
        });
      }
      return real.createVersion(t0(tx), args);
    },
  };
});
const t0 = (x: never) =>
  x as Parameters<typeof import("../../src/plan/versions.js").createVersion>[0];

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate table proposals, pending_actions, write_ledger, log_entries, log_groups, session_items, suggestions, session_overrides, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  await seedPlan(db, fixture());
});

const START = "2026-09-28"; // Monday
const TODAY = "2026-10-19"; // Monday of week 4
const TOMORROW = "2026-10-20";

function item(
  week: number,
  weekday: ParsedItem["weekday"],
  order: number,
  options: string[],
  over: Partial<ParsedItem> = {},
): ParsedItem {
  return {
    key: `w${String(week).padStart(2, "0")}-${weekday}-${String(order).padStart(2, "0")}-0`,
    week,
    weekday,
    order,
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
    ...over,
  };
}

function ex(
  slug: string,
  name: string,
  over: Partial<ResolvedPlan["plan"]["exercises"][number]> = {},
): ResolvedPlan["plan"]["exercises"][number] {
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
    ...over,
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
  // Week 6 is a deload to check RIR 3-4 stays there.
  weeks[5] = {
    week: 6,
    phase: "Base",
    is_deload: true,
    is_test: false,
    start_date: addDays(START, 35),
  };
  const items = weeks.flatMap((w) => [
    item(w.week, "mon", 0, ["face_pull"]),
    item(w.week, "mon", 1, ["pike_push_up_ex"], { hspu_step: "pike_push_up" }),
    item(w.week, "tue", 0, ["squat"], { rir_min: 1, rir_max: 2 }),
    item(w.week, "fri", 0, ["squat"], { rir_min: 1, rir_max: 2 }),
  ]);
  return {
    open_issues: [],
    resolved_hash: "resolved-swap-exec",
    plan: {
      source_hash: "hash-swap-exec",
      name: "Swap Exec Plan",
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
        ex("squat", "Squat", { is_main_lift: true, muscle_group: "legs" }),
        ex("leg_press", "Leg press", { muscle_group: "legs" }),
        ex("pike_push_up_ex", "HSPU", { type: "skill_ladder", load_basis: null }),
        ex("push_up", "Push-up", { type: "bodyweight_reps", load_basis: null }),
      ],
      items,
    },
  };
}

const swapInput = (over: Record<string, unknown> = {}) => ({
  exercise: { said: "face pull" },
  replacement: { said: "leg press" },
  ...over,
});

async function resolved(input: Record<string, unknown>, today = TODAY): Promise<ResolvedSwap> {
  const r = await resolveSwap(db, input as never, today);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reply}`);
  return r.resolved;
}

const num = async (q: string): Promise<number> => ((await sql.unsafe(q))[0]?.n ?? -1) as number;

async function run(r: ResolvedSwap, alias = "leg press", today = TODAY) {
  return db.transaction((tx) => executeSwap(tx, r, alias, today));
}

const bandSpec = {
  said: "band pull apart",
  new: {
    name: "Band pull-apart",
    type: "bodyweight_reps",
    muscle_group: "back",
    equipment_slug: "band",
  },
};

describe("executeSwap: today", () => {
  it("writes one override for the item", async () => {
    const r = await resolved(swapInput({ scope: "today" }));
    const out = await run(r);
    if ("refused" in out) throw new Error(out.refused);
    expect(out.versionId).toBeNull();
    expect(out.overrideIds).toHaveLength(1);
    const rows = await sql`select * from session_overrides`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_date).toBe(TODAY);
    expect(await num("select count(*)::int as n from plan_versions")).toBe(1);
  });

  it("refuses when already logged, writing nothing", async () => {
    const r = await resolved(swapInput({ scope: "today" }));
    const [face] = await sql`select id from exercises where slug = 'face_pull'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source) values (${TODAY}, now(), ${face?.id}, 'text')`;
    const out = await run(r);
    expect(out).toEqual({ refused: "You already logged Face pull today; nothing changed." });
    expect(await num("select count(*)::int as n from session_overrides")).toBe(0);
  });
});

describe("executeSwap: rest of plan", () => {
  it("creates version 2 effective tomorrow and today's override", async () => {
    const r = await resolved(swapInput({ scope: "rest" }));
    const out = await run(r);
    if ("refused" in out) throw new Error(out.refused);
    expect(out.versionId).not.toBeNull();
    expect(out.overrideIds).toHaveLength(1);
    const [v] = await sql`select * from plan_versions where version = 2`;
    expect(v?.effective_from).toBe(TOMORROW);
    expect(v?.change).toMatchObject({ kind: "swap", weekdays: ["mon"], fromDate: TOMORROW });
    expect(v?.reason).toBe("swap Face pull → Leg press");
    const day = await planDayOn(db, TODAY);
    if (day.kind !== "day") throw new Error(day.kind);
    expect(day.items.find((i) => i.swappedToday)?.options.map((o) => o.name)).toContain(
      "Leg press",
    );
  });

  it("this_day leaves the other weekday untouched", async () => {
    const r = await resolved(
      swapInput({
        exercise: { said: "squat" },
        replacement: { said: "leg press" },
        scope: "rest",
        days: "this_day",
      }),
    );
    expect(r.referenceWeekday).toBe("tue");
    const out = await run(r);
    if ("refused" in out) throw new Error(out.refused);
    const rows = await sql`
      select pi.weekday, e.slug, count(*)::int as n
      from planned_items pi join planned_item_options o on o.planned_item_id = pi.id
      join exercises e on e.id = o.exercise_id
      where pi.plan_version_id = ${out.versionId} and pi.week >= 4 and pi.weekday in ('tue','fri')
      group by 1, 2 order by 1`;
    const tue = rows.filter((x) => x.weekday === "tue").map((x) => x.slug);
    const fri = rows.filter((x) => x.weekday === "fri").map((x) => x.slug);
    expect(tue).toEqual(["leg_press"]);
    expect(fri).toEqual(["squat"]);
    // Reference is tomorrow (Tue), not today: no override.
    expect(out.overrideIds).toEqual([]);
  });

  it("a future reference date gives effective_from = that date and no override", async () => {
    const r = await resolved(
      swapInput({
        exercise: { said: "squat" },
        replacement: { said: "leg press" },
        scope: "rest",
        days: "every_day",
        day: "fri",
      }),
    );
    expect(r.referenceDate).toBe("2026-10-23");
    const out = await run(r);
    if ("refused" in out) throw new Error(out.refused);
    const [v] = await sql`select effective_from from plan_versions where version = 2`;
    expect(v?.effective_from).toBe("2026-10-23");
    expect(out.overrideIds).toEqual([]);
  });

  it("recomputes RIR: main lift to non-main is 1-3, deload stays 3-4", async () => {
    const r = await resolved(
      swapInput({
        exercise: { said: "squat" },
        replacement: { said: "leg press" },
        scope: "rest",
        days: "every_day",
      }),
    );
    const out = await run(r);
    if ("refused" in out) throw new Error(out.refused);
    const rows = await sql`
      select pi.week, pi.rir_min::float as lo, pi.rir_max::float as hi
      from planned_items pi
      where pi.plan_version_id = ${out.versionId} and pi.weekday = 'tue' and pi.week in (5, 6)
      order by pi.week`;
    expect([rows[0]?.lo, rows[0]?.hi]).toEqual([1, 3]);
    expect([rows[1]?.lo, rows[1]?.hi]).toEqual([3, 4]);
    // Earlier weeks keep the original RIR.
    const [old] = await sql`
      select rir_min::float as lo, rir_max::float as hi from planned_items
      where plan_version_id = ${out.versionId} and weekday = 'tue' and week = 1`;
    expect([old?.lo, old?.hi]).toEqual([1, 2]);
  });

  it("an HSPU swap clears the step and the fallback", async () => {
    const r = await resolved(
      swapInput({
        exercise: { said: "hspu" },
        replacement: { said: "push-up", slug: "push_up" },
        scope: "rest",
      }),
    );
    const out = await run(r, "push-up");
    if ("refused" in out) throw new Error(out.refused);
    const rows = await sql`
      select hspu_step_id, fallback_prescription from planned_items
      where plan_version_id = ${out.versionId} and week >= 5 and weekday = 'mon' and item_order = 1`;
    expect(rows.length).toBeGreaterThan(0);
    for (const x of rows) {
      expect(x.hspu_step_id).toBeNull();
      expect(x.fallback_prescription).toBeNull();
    }
    const [early] = await sql`
      select hspu_step_id from planned_items
      where plan_version_id = ${out.versionId} and week = 1 and weekday = 'mon' and item_order = 1`;
    expect(early?.hspu_step_id).not.toBeNull();
  });

  it("creates a new exercise once, not main lift, with the alias", async () => {
    const r = await resolved(swapInput({ scope: "rest", replacement: bandSpec }));
    expect(r.to.isNew).toBe(true);
    const out = await run(r, "band pull apart");
    if ("refused" in out) throw new Error(out.refused);
    expect(out.createdExerciseId).not.toBeNull();
    const rows = await sql`select * from exercises where slug = 'band_pull_apart'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      is_main_lift: false,
      aliases: ["band pull apart"],
      type: "bodyweight_reps",
    });
    expect(rows[0]?.equipment_id).not.toBeNull();
    // Same slug existing by now: reused, not created again.
    const again = await run(
      await resolved(
        swapInput({ exercise: { said: "squat" }, scope: "today", replacement: bandSpec }),
      ),
      "x",
    );
    // resolveSwap now finds it in the catalog, so it is no longer new.
    if ("refused" in again) throw new Error(again.refused);
    expect(again.createdExerciseId).toBeNull();
    expect(
      await num("select count(*)::int as n from exercises where slug = 'band_pull_apart'"),
    ).toBe(1);
  });

  it("reuses an exercise that appeared after the card was built", async () => {
    const r = await resolved(swapInput({ scope: "today", replacement: bandSpec }));
    expect(r.to.isNew).toBe(true);
    await sql`insert into exercises (slug, name, muscle_group, type, is_main_lift) values ('band_pull_apart', 'Band pull-apart', 'back', 'bodyweight_reps', false)`;
    const out = await run(r, "band pull apart");
    if ("refused" in out) throw new Error(out.refused);
    expect(out.createdExerciseId).toBeNull();
    expect(
      await num("select count(*)::int as n from exercises where slug = 'band_pull_apart'"),
    ).toBe(1);
  });

  it("refuses with the plan-changed reply on a stale base", async () => {
    const r = await resolved(swapInput({ scope: "rest" }));
    race.on = true;
    const out = await run(r);
    race.on = false;
    expect(out).toEqual({ refused: "The plan changed meanwhile, try again." });
  });
});

describe("swap through the executor", () => {
  async function stagedPending() {
    const r = await stageSwap(
      db,
      swapInput({ scope: "rest" }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    if (!r.ok) throw new Error(r.error);
    const { pending } = await createPending(db, {
      chatId: 1,
      kind: "confirm",
      actions: [r.action],
      reasons: [],
      sourceUpdateId: 5,
      now: new Date("2026-10-19T09:00:00Z"),
    });
    return { pending, action: r.action as StagedAction };
  }

  it("a second confirm returns the stored result and writes nothing", async () => {
    const { pending, action } = await stagedPending();
    const now = new Date("2026-10-19T09:01:00Z");
    const key = `p:${pending.id}`;
    const a = await executeActions(db, key, [action], { pendingId: pending.id, now });
    const b = await executeActions(db, key, [action], { pendingId: pending.id, now });
    expect(a.status).toBe("done");
    expect(b).toEqual(a);
    expect(await num("select count(*)::int as n from plan_versions")).toBe(2);
    expect(await num("select count(*)::int as n from session_overrides")).toBe(1);
  });

  it("reports a refusal and writes nothing", async () => {
    const r = await stageSwap(
      db,
      swapInput({ scope: "today" }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    if (!r.ok) throw new Error(r.error);
    const [face] = await sql`select id from exercises where slug = 'face_pull'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source) values (${TODAY}, now(), ${face?.id}, 'text')`;
    const out = await executeActions(db, "p:99", [r.action], {
      now: new Date("2026-10-19T09:01:00Z"),
    });
    expect(out).toEqual({
      status: "refused",
      reply: "You already logged Face pull today; nothing changed.",
    });
    expect(await num("select count(*)::int as n from session_overrides")).toBe(0);
  });
});

describe("undoPlanChange", () => {
  async function saved(over: Record<string, unknown> = { scope: "rest" }, spec = swapInput(over)) {
    const r = await stageSwap(db, spec as never, new Date("2026-10-19T09:00:00Z"));
    if (!r.ok) throw new Error(r.error);
    const out = await executeActions(db, "p:7", [r.action], {
      now: new Date("2026-10-19T09:01:00Z"),
    });
    if (out.status !== "done") throw new Error(out.status);
    return out.results[0];
  }

  it("right after saving restores the plan", async () => {
    const before = await planDayOn(db, TODAY);
    await saved();
    expect(await num("select count(*)::int as n from plan_versions")).toBe(2);
    const u = await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(u).toEqual({ ok: true });
    expect(await num("select count(*)::int as n from plan_versions")).toBe(1);
    expect(await num("select count(*)::int as n from session_overrides")).toBe(0);
    expect(
      await num(
        "select count(*)::int as n from planned_items where plan_version_id not in (select id from plan_versions)",
      ),
    ).toBe(0);
    expect(await planDayOn(db, TODAY)).toEqual(before);
  });

  it("removes a created exercise when nothing uses it", async () => {
    await saved({ scope: "rest", replacement: bandSpec });
    expect(
      await num("select count(*)::int as n from exercises where slug = 'band_pull_apart'"),
    ).toBe(1);
    await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(
      await num("select count(*)::int as n from exercises where slug = 'band_pull_apart'"),
    ).toBe(0);
  });

  it("is refused once a log references the version", async () => {
    await saved();
    const [item] = await sql`
      select pi.id, o.exercise_id from planned_items pi
      join planned_item_options o on o.planned_item_id = pi.id
      join plan_versions v on v.id = pi.plan_version_id
      where v.version = 2 and pi.week = 5 and pi.weekday = 'mon' and pi.item_order = 0`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, planned_item_id, source) values ('2026-10-26', now(), ${item?.exercise_id}, ${item?.id}, 'text')`;
    const u = await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(u).toEqual({
      ok: false,
      reply: "Too late to undo: it's already in use. Swap back instead.",
    });
    expect(await num("select count(*)::int as n from plan_versions")).toBe(2);
  });

  it("is refused when today's override was used by a log", async () => {
    await saved({ scope: "today" });
    const [lp] = await sql`select id from exercises where slug = 'leg_press'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source) values (${TODAY}, now(), ${lp?.id}, 'text')`;
    const u = await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(u.ok).toBe(false);
    expect(await num("select count(*)::int as n from session_overrides")).toBe(1);
  });

  it("is refused when a newer version exists", async () => {
    await saved();
    const r = await stageSwap(
      db,
      swapInput({ exercise: { said: "squat" }, scope: "rest", days: "every_day" }) as never,
      new Date("2026-10-19T09:00:00Z"),
    );
    if (!r.ok) throw new Error(r.error);
    await executeActions(db, "p:8", [r.action], { now: new Date("2026-10-19T09:01:00Z") });
    const u = await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(u.ok).toBe(false);
  });

  it("a second undo says Already undone", async () => {
    await saved();
    await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    const u = await db.transaction((tx) => undoPlanChange(tx, "p:7", 0));
    expect(u).toEqual({ ok: false, reply: "Already undone." });
  });

  it("an r: key declines its proposal", async () => {
    await saved();
    await sql`update write_ledger set source_key = 'r:1'`;
    await sql`insert into proposals (kind, payload, status) values ('earlier_deload', '{}'::jsonb, 'accepted')`;
    const u = await db.transaction((tx) => undoPlanChange(tx, "r:1", 0));
    expect(u).toEqual({ ok: true });
    const [p] = await sql`select status from proposals where id = 1`;
    expect(p?.status).toBe("declined");
  });
});
