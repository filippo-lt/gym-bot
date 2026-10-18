/**
 * DB layer of the progression engine (M5 WP4): derived state, stored suggestions, frozen readiness, history loading.
 * Plan: the synthetic fixture stretched to 9 weeks (deloads in W4 and W8), Mondays only.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedPlan } from "../../src/db/seed-plan.js";
import { executeActions } from "../../src/logging/execute.js";
import { skipAction } from "../../src/logging/skip.js";
import type { CatalogExercise, ParsedItem } from "../../src/plan-import/types.js";
import { systemLoadOf } from "../../src/progression/e1rm.js";
import {
  loadExerciseInfos,
  loadPlanEnv,
  loadReadinessSignals,
  loadSessionInput,
  loadSessionRecs,
} from "../../src/progression/load-history.js";
import {
  ensureSuggestions,
  freezeReadiness,
  refreshUserState,
  suggestionKey,
} from "../../src/progression/store.js";
import { planFixture } from "../history-import/plan-fixture.js";
import { connect, exId, LADDER } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const pad = (n: number) => String(n).padStart(2, "0");
const MONDAYS = [
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
  "2026-11-02",
  "2026-11-09",
  "2026-11-16",
  "2026-11-23",
];
const DELOAD_WEEKS = new Set([4, 8]);

const HSPU: CatalogExercise = {
  slug: "hspu",
  name: "HSPU",
  aliases: [],
  muscle_group: "shoulders",
  type: "skill_ladder",
  load_basis: null,
  equipment_slug: null,
  is_main_lift: false,
  review_note: null,
};

function ninePlan() {
  const r = planFixture();
  r.plan.exercises.push(HSPU);
  r.plan.hspu_ladder = LADDER;
  const base = r.plan.items.filter((i) => i.week === 1);
  const tue = base.find((i) => i.weekday === "tue") as ParsedItem;
  base.push({
    ...tue,
    key: "w01-tue-01-0",
    order: 1,
    plan_name: "HSPU progression",
    exercise_options: ["hspu"],
    hspu_step: "hspu_negative",
    sets_min: 3,
    sets_max: 3,
    reps_min: 3,
    reps_max: 3,
  });
  r.plan.items = [];
  r.plan.weeks = [];
  for (let w = 1; w <= 9; w++) {
    r.plan.weeks.push({
      week: w,
      phase: DELOAD_WEEKS.has(w) ? "Deload" : "Base",
      is_deload: DELOAD_WEEKS.has(w),
      is_test: false,
      start_date: MONDAYS[w - 1] as string,
    });
    for (const it of base) {
      r.plan.items.push({
        ...it,
        key: it.key.replace(/^w\d\d/, `w${pad(w)}`),
        week: w,
      });
    }
  }
  r.plan.weeks_count = 9;
  return r;
}

beforeEach(async () => {
  await sql`truncate table suggestions, readiness_logs, user_state, proposals, write_ledger, pending_actions, memory_items, conversation_messages, usage_logs, log_entries, log_groups, session_items, class_logs, weekly_metrics, bodyweight_logs, planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment restart identity cascade`;
  await seedPlan(db, ninePlan());
  await sql`update exercises set is_main_lift = true where slug in ('squat', 'hack_squat', 'bench_press', 'pull_up')`;
  await sql`update equipment set bands = ${JSON.stringify({ red: 10, black: 20 })}::jsonb where slug = 'pullup'`;
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 80, 'import')`;
});

interface SetIn {
  reps: number;
  load?: number;
  added?: number;
  band?: string;
  rir?: number;
  rirPlus?: boolean;
  clean?: boolean;
  pad?: number;
}

async function itemId(key: string): Promise<number> {
  const [r] = await sql`select id from planned_items where item_key = ${key}`;
  return r?.id as number;
}

async function logGroup(opts: {
  slug: string;
  date: string;
  itemKey?: string;
  sets: SetIn[];
  source?: "text" | "import";
  bw?: number | null;
  readiness?: string | null;
  suggestionId?: number | null;
  hspuStep?: string;
}): Promise<number> {
  const exerciseId = await exId(sql, opts.slug);
  const plannedItemId = opts.itemKey ? await itemId(opts.itemKey) : null;
  const stepId = opts.hspuStep
    ? (await sql`select id from hspu_ladder where slug = ${opts.hspuStep}`)[0]?.id
    : null;
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, planned_item_id, exercise_id, source, bw_kg, readiness_level, suggestion_id, hspu_step_id)
    values (${opts.date}, ${`${opts.date}T08:00:00Z`}, ${plannedItemId}, ${exerciseId}, ${opts.source ?? "text"},
      ${opts.bw === undefined ? 80 : opts.bw}, ${opts.readiness ?? null}, ${opts.suggestionId ?? null}, ${stepId})
    returning id`;
  for (const [i, s] of opts.sets.entries()) {
    await sql`
      insert into log_entries (group_id, set_index, reps, load_kg, added_kg, band, rir, rir_plus, clean, pad_height)
      values (${g?.id}, ${i + 1}, ${s.reps}, ${s.load ?? null}, ${s.added ?? null}, ${s.band ?? null},
        ${s.rir ?? null}, ${s.rirPlus ?? false}, ${s.clean ?? null}, ${s.pad ?? null})`;
  }
  return g?.id as number;
}

const bench = (load: number, rir = 2): SetIn[] => [
  { reps: 8, load, rir },
  { reps: 8, load, rir },
];

/** Monday bench (item order 3) and squat (OR item, order 4) for the given plan weeks. */
async function logMondays(weeks: number[], opts: { skip?: (w: number) => boolean } = {}) {
  for (const w of weeks) {
    if (opts.skip?.(w)) continue;
    const date = MONDAYS[w - 1] as string;
    const deload = DELOAD_WEEKS.has(w);
    await logGroup({
      slug: "bench_press",
      date,
      itemKey: `w${pad(w)}-mon-03-0`,
      sets: bench(deload ? 50 : 60, deload ? 3 : 2),
    });
    await logGroup({
      slug: "squat",
      date,
      itemKey: `w${pad(w)}-mon-04-0`,
      sets: bench(deload ? 70 : 80, deload ? 3 : 2),
    });
  }
}

function benchItem(r: NonNullable<Awaited<ReturnType<typeof ensureSuggestions>>>) {
  const item = r.session.items.find((i) => i.target.planName === "Bench press");
  if (!item) throw new Error("no bench item");
  return item;
}

describe("derived state (SPEC 9)", () => {
  it("undo of the set that opened the pull-up gate closes it again", async () => {
    await logGroup({
      slug: "pull_up",
      date: "2026-09-28",
      itemKey: "w01-mon-01-0",
      sets: [{ reps: 6, clean: true, rir: 1 }],
    });
    const open = await db.transaction((tx) => refreshUserState(tx));
    expect(open.pullupGateOpen).toBe(true);
    expect(open.pullupGateSince).toBe("2026-09-28");
    const [row1] = await sql`select pullup_gate_open from user_state where id = 1`;
    expect(row1?.pullup_gate_open).toBe(true);

    await sql`delete from log_groups where session_date = '2026-09-28'`;
    const closed = await db.transaction((tx) => refreshUserState(tx));
    expect(closed.pullupGateOpen).toBe(false);
    const [row2] =
      await sql`select pullup_gate_open, pullup_gate_since from user_state where id = 1`;
    expect(row2?.pullup_gate_open).toBe(false);
    expect(row2?.pullup_gate_since).toBeNull();
  });

  it("a weekly check-in max of 6+ opens the gate (dated to that week's Friday)", async () => {
    await sql`insert into weekly_metrics (plan_week, metric, value_num, source) values (2, 'pullups', 7, 'import')`;
    const state = await db.transaction((tx) => refreshUserState(tx));
    expect(state.pullupGateOpen).toBe(true);
    expect(state.pullupGateSince).toBe("2026-10-09");
    expect(state.lastBwMax).toBe(7);
  });

  it("re-import rebuilds the HSPU step", async () => {
    await logGroup({
      slug: "hspu",
      date: "2026-09-29",
      itemKey: "w01-tue-01-0",
      source: "import",
      sets: [{ reps: 3, clean: true, pad: 20 }],
      hspuStep: "hspu_negative",
    });
    const first = await db.transaction((tx) => refreshUserState(tx));
    expect(first.hspuStepOrder).toBe(1);
    expect(first.hspuPadHeight).toBe(20);

    // Re-import: the old rows go, the corrected export comes back with another step.
    await sql`delete from log_groups where source = 'import'`;
    await logGroup({
      slug: "hspu",
      date: "2026-09-29",
      itemKey: "w01-tue-01-0",
      source: "import",
      sets: [{ reps: 3, clean: true, pad: 15 }],
      hspuStep: "partial_rom_wall_hspu",
    });
    const second = await db.transaction((tx) => refreshUserState(tx));
    expect(second.hspuStepOrder).toBe(2);
    expect(second.hspuPadHeight).toBe(15);
    const [row] = await sql`
      select l.step_order, u.hspu_pad_height::float as pad
      from user_state u join hspu_ladder l on l.id = u.hspu_step_id`;
    expect(row?.step_order).toBe(2);
    expect(row?.pad).toBe(15);
  });
});

describe("stored suggestions", () => {
  it("is idempotent and freezes a row once a log group references it", async () => {
    await logMondays([1]);
    const date = "2026-10-05";
    const first = await ensureSuggestions(db, date);
    expect(first).not.toBeNull();
    const [count1] = await sql`select count(*)::int as n, max(updated_at) as u from suggestions`;
    const second = await ensureSuggestions(db, date);
    const [count2] = await sql`select count(*)::int as n from suggestions`;
    expect(count2?.n).toBe(count1?.n);
    expect([...(second?.ids ?? [])]).toEqual([...(first?.ids ?? [])]);

    const item = benchItem(first as NonNullable<typeof first>);
    const benchEx = await exId(sql, "bench_press");
    const slot = suggestionKey(item.target.plannedItemId, item.target.subItem, benchEx);
    const benchSugId = first?.ids.get(slot) as number;
    expect(benchSugId).toBeGreaterThan(0);
    const before = item.suggestion?.loadKg;
    expect(before).toBeGreaterThan(0);

    // The user logs against the suggestion: it is now frozen.
    await logGroup({
      slug: "bench_press",
      date,
      itemKey: "w02-mon-03-0",
      sets: bench(before as number),
      suggestionId: benchSugId,
    });
    // A "tired" tap would turn the plan YELLOW and change every unfrozen row, but not the one already used.
    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:00:00Z`}, 'button_tired', 'button')`;
    await freezeReadiness(db, date, new Date(`${date}T06:00:00Z`), { refreeze: true });
    const third = await ensureSuggestions(db, date);
    const [row] =
      await sql`select load_kg::float as load, readiness_level from suggestions where id = ${benchSugId}`;
    expect(row?.load).toBe(before);
    // Frozen: neither the stored row nor the returned session changes, even though the plan would now be YELLOW.
    expect(row?.readiness_level).toBe("GREEN");
    expect(third?.frozenIds.has(benchSugId)).toBe(true);
    expect(benchItem(third as NonNullable<typeof third>).suggestion?.loadKg).toBe(before);
  });

  it("rewrites unreferenced rows when the frozen level changes before the first log", async () => {
    await logMondays([1]);
    const date = "2026-10-05";
    await freezeReadiness(db, date, new Date(`${date}T04:00:00Z`));
    const green = await ensureSuggestions(db, date);
    expect(green?.session.level).toBe("GREEN");
    const greenLoad = benchItem(green as NonNullable<typeof green>).suggestion?.loadKg as number;

    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:00:00Z`}, 'button_tired', 'button')`;
    const re = await freezeReadiness(db, date, new Date(`${date}T05:30:00Z`), { refreeze: true });
    expect(re.level).toBe("YELLOW");
    const yellow = await ensureSuggestions(db, date);
    expect(yellow?.session.level).toBe("YELLOW");
    const item = benchItem(yellow as NonNullable<typeof yellow>);
    expect(item.suggestion?.labels).toContain("readiness_yellow");
    // RIR 2.5 instead of 1.5: lighter or equal.
    expect(item.suggestion?.loadKg as number).toBeLessThanOrEqual(greenLoad);
    const [n] =
      await sql`select count(*)::int as n from suggestions where session_date = ${date} and exercise_id = ${await exId(sql, "bench_press")}`;
    expect(n?.n).toBe(1);
  });

  it("asks for the load and stores nothing when there is no valid session", async () => {
    const r = await ensureSuggestions(db, "2026-09-28");
    const item = benchItem(r as NonNullable<typeof r>);
    expect(item.suggestion?.ask).toBe("load");
    expect(item.suggestion?.labels).toContain("baseline_ask_load");
    const [n] =
      await sql`select count(*)::int as n from suggestions where exercise_id = ${await exId(sql, "bench_press")}`;
    expect(n?.n).toBe(0);
  });

  it("returns null for a weekend", async () => {
    expect(await ensureSuggestions(db, "2026-10-03")).toBeNull();
  });
});

describe("break rule on real history", () => {
  const labelsOf = (r: NonNullable<Awaited<ReturnType<typeof ensureSuggestions>>>) =>
    benchItem(r).suggestion?.labels ?? [];

  it("W5 Monday with full W1-W4 history shows no break", async () => {
    await logMondays([1, 2, 3, 4]);
    const r = await ensureSuggestions(db, "2026-10-26");
    expect(labelsOf(r as NonNullable<typeof r>)).not.toContain("back_after_break");
    expect(benchItem(r as NonNullable<typeof r>).suggestion?.loadKg).toBeGreaterThan(0);
  });

  it("W9 Monday with full W1-W8 history shows no break", async () => {
    await logMondays([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = await ensureSuggestions(db, "2026-11-23");
    expect(labelsOf(r as NonNullable<typeof r>)).not.toContain("back_after_break");
  });

  it("control: two missed Mondays in a row cut 10% and label it", async () => {
    await logMondays([1, 2, 3, 4], { skip: (w) => w === 2 || w === 3 });
    const withBreak = await ensureSuggestions(db, "2026-10-26");
    const labels = labelsOf(withBreak as NonNullable<typeof withBreak>);
    expect(labels).toContain("back_after_break");
  });

  it("explicit /skip of two Mondays in a row counts as not logged (break applies)", async () => {
    await logMondays([1, 4], {});
    for (const w of [2, 3]) {
      const r = await executeActions(
        db,
        `u:${9000 + w}`,
        [
          skipAction(MONDAYS[w - 1] as string, false, [
            {
              plannedItemId: await itemId(`w${pad(w)}-mon-03-0`),
              planName: "Bench press",
              priority: "High",
            },
          ]),
        ],
        { now: new Date(`${MONDAYS[w - 1]}T08:00:00Z`) },
      );
      expect(r.status).toBe("done");
    }
    expect(await sql`select 1 from session_items where status = 'skipped'`).toHaveLength(2);
    // A skip is not training: it freezes no readiness and writes no user_state cache.
    expect(await sql`select 1 from readiness_logs`).toHaveLength(0);
    const r = await ensureSuggestions(db, "2026-10-26");
    expect(labelsOf(r as NonNullable<typeof r>)).toContain("back_after_break");
  });

  it("deload weeks never count as misses", async () => {
    // W3 not logged, W4 (deload) not logged: only W3 is a miss because the deload week is excluded.
    await logMondays([1, 2]);
    await sql`insert into class_logs (date, heavy_groups, source) values ('2026-10-22', ${sql.array([])}, 'import')`;
    const r = await ensureSuggestions(db, "2026-10-26");
    expect(labelsOf(r as NonNullable<typeof r>)).not.toContain("back_after_break");
  });
});

describe("OR items", () => {
  it("hack squat logs never feed squat suggestions", async () => {
    await logMondays([1, 2]);
    const date = "2026-10-12";
    const squatEx = await exId(sql, "squat");
    const hackEx = await exId(sql, "hack_squat");
    const pick = (r: NonNullable<Awaited<ReturnType<typeof ensureSuggestions>>>, ex: number) => {
      const item = r.session.items.find((i) => i.target.exerciseIds.includes(squatEx));
      return item?.suggestions[ex] ?? null;
    };
    const before = await ensureSuggestions(db, date);
    const squatBefore = pick(before as NonNullable<typeof before>, squatEx);
    expect(squatBefore?.loadKg).toBeGreaterThan(0);
    expect(pick(before as NonNullable<typeof before>, hackEx)?.ask).toBe("load");

    // Heavy hack squat sessions.
    for (const d of ["2026-09-28", "2026-10-05"]) {
      await logGroup({
        slug: "hack_squat",
        date: d,
        itemKey: `w0${d === "2026-09-28" ? 1 : 2}-mon-04-0`,
        sets: [
          { reps: 8, load: 200, rir: 1 },
          { reps: 8, load: 200, rir: 1 },
        ],
      });
    }
    const after = await ensureSuggestions(db, date);
    const squatAfter = pick(after as NonNullable<typeof after>, squatEx);
    expect(squatAfter?.loadKg).toBe(squatBefore?.loadKg);
    expect(squatAfter?.e1rmUsed).toBe(squatBefore?.e1rmUsed);
    const hackAfter = pick(after as NonNullable<typeof after>, hackEx);
    expect(hackAfter?.loadKg).toBeGreaterThan(squatAfter?.loadKg as number);
  });
});

describe("readiness freeze", () => {
  it("is computed once at session start and not changed by later signals", async () => {
    const date = "2026-10-05";
    const first = await freezeReadiness(db, date, new Date(`${date}T04:30:00Z`));
    expect(first).toMatchObject({ level: "GREEN", frozen: true, written: true });
    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:00:00Z`}, 'button_tired', 'button')`;
    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:01:00Z`}, 'chat_sore', 'chat')`;
    const again = await freezeReadiness(db, date, new Date(`${date}T06:00:00Z`));
    expect(again).toMatchObject({ level: "GREEN", frozen: true, written: false });
    const [n] =
      await sql`select count(*)::int as n from readiness_logs where source = 'derived' and date = ${date}`;
    expect(n?.n).toBe(1);

    const r = await ensureSuggestions(db, date);
    expect(r?.session.level).toBe("GREEN");
    expect(r?.input.frozenLevel).toBe("GREEN");
  });

  it("a re-freeze tap works before the first log and not after", async () => {
    const date = "2026-10-05";
    await freezeReadiness(db, date, new Date(`${date}T04:30:00Z`));
    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:00:00Z`}, 'button_tired', 'button')`;
    const re = await freezeReadiness(db, date, new Date(`${date}T05:05:00Z`), { refreeze: true });
    expect(re).toMatchObject({ level: "YELLOW", written: true });
    await sql`insert into readiness_logs (date, at, kind, source) values (${date}, ${`${date}T05:10:00Z`}, 'chat_sore', 'chat')`;
    await logGroup({ slug: "bench_press", date, sets: bench(60) });
    const late = await freezeReadiness(db, date, new Date(`${date}T07:00:00Z`), { refreeze: true });
    expect(late).toMatchObject({ level: "YELLOW", written: false });
  });

  it("/today before 05:00 Rome only previews", async () => {
    const date = "2026-10-05";
    // 03:30 Rome (CEST) = 01:30 UTC.
    const early = await freezeReadiness(db, date, new Date(`${date}T01:30:00Z`), {
      trigger: "today",
    });
    expect(early.frozen).toBe(false);
    const [n] = await sql`select count(*)::int as n from readiness_logs where source = 'derived'`;
    expect(n?.n).toBe(0);
    const ok = await freezeReadiness(db, date, new Date(`${date}T04:00:00Z`), { trigger: "today" });
    expect(ok.frozen).toBe(true);
  });

  it("drift recorded during a session only reaches the next session", async () => {
    await logMondays([1]);
    const date = "2026-10-05";
    await freezeReadiness(db, date, new Date(`${date}T04:30:00Z`));
    const r = await ensureSuggestions(db, date);
    const item = benchItem(r as NonNullable<typeof r>);
    const benchEx = await exId(sql, "bench_press");
    const sugId = r?.ids.get(
      suggestionKey(item.target.plannedItemId, item.target.subItem, benchEx),
    );
    const load = item.suggestion?.loadKg as number;
    const repsMin = item.suggestion?.repsMin as number;
    // Drift: reps + RIR <= reps_min + rir_mid - 2, at the suggested load.
    await logGroup({
      slug: "bench_press",
      date,
      itemKey: "w02-mon-03-0",
      suggestionId: sugId,
      sets: [{ reps: repsMin - 2, load, rir: 0 }],
    });

    const env = (await loadPlanEnv(db)) as NonNullable<Awaited<ReturnType<typeof loadPlanEnv>>>;
    const sameDay = await loadReadinessSignals(db, env, date);
    expect(sameDay.some((s) => s.kind === "drift")).toBe(false);
    const sameSession = await ensureSuggestions(db, date);
    expect(sameSession?.session.level).toBe("GREEN");

    const nextDate = "2026-10-12";
    const next = await loadReadinessSignals(db, env, nextDate);
    const drift = next.filter((s) => s.kind === "drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.lift).toBe(benchEx);
    const nextSession = await ensureSuggestions(db, nextDate, { asOf: `${nextDate}T06:00:00Z` });
    expect(nextSession?.session.level).toBe("YELLOW");

    // The lift is logged again at the next session: that drift is gone.
    await logGroup({
      slug: "bench_press",
      date: nextDate,
      itemKey: "w03-mon-03-0",
      sets: bench(60),
    });
    const later = await loadReadinessSignals(db, env, "2026-10-19");
    expect(later.some((s) => s.kind === "drift")).toBe(false);
  });
});

describe("history loading", () => {
  it("uses equipment.bands kg for band sets and no load math for unmapped bands", async () => {
    await logGroup({
      slug: "pull_up",
      date: "2026-09-28",
      itemKey: "w01-mon-01-0",
      sets: [
        { reps: 5, band: "red", rir: 1, clean: true },
        { reps: 5, band: "purple", rir: 1, clean: true },
      ],
    });
    const env = (await loadPlanEnv(db)) as NonNullable<Awaited<ReturnType<typeof loadPlanEnv>>>;
    const puId = await exId(sql, "pull_up");
    const infos = await loadExerciseInfos(db, [puId]);
    const recs = await loadSessionRecs(db, env, infos, [puId], "2026-10-05");
    const rec = recs.get(puId)?.[0];
    expect(rec?.sets[0]?.assistKg).toBe(10);
    expect(rec?.sets[0]?.band).toBe("red");
    const ex = infos[puId];
    expect(ex).toBeDefined();
    const [s0, s1] = rec?.sets ?? [];
    if (!ex || !rec || !s0 || !s1) throw new Error("missing sets");
    expect(systemLoadOf(s0, ex, rec.bwKg)).toBe(70);
    expect(rec.sets[1]?.assistKg).toBeNull();
    expect(systemLoadOf(s1, ex, rec.bwKg)).toBeNull();
    expect(rec.week).toBe(1);
    expect(rec.plannedItemIds).toHaveLength(1);
  });

  it("merges the groups of one day in set order and flags imports", async () => {
    await logGroup({
      slug: "bench_press",
      date: "2026-09-28",
      sets: [{ reps: 8, load: 60, rir: 2 }],
      source: "import",
    });
    await logGroup({
      slug: "bench_press",
      date: "2026-09-28",
      sets: [{ reps: 7, load: 60, rir: 1 }],
    });
    await logGroup({
      slug: "bench_press",
      date: "2026-10-05",
      sets: [{ reps: 8, load: 62.5, rir: 2 }],
      source: "import",
    });
    const env = (await loadPlanEnv(db)) as NonNullable<Awaited<ReturnType<typeof loadPlanEnv>>>;
    const id = await exId(sql, "bench_press");
    const infos = await loadExerciseInfos(db, [id]);
    const recs = (await loadSessionRecs(db, env, infos, [id], null)).get(id) ?? [];
    expect(recs.map((r) => r.date)).toEqual(["2026-10-05", "2026-09-28"]);
    expect(recs[1]?.sets.map((s) => s.reps)).toEqual([8, 7]);
    expect(recs[1]?.source).toBe("bot");
    expect(recs[0]?.source).toBe("import");
  });

  it("builds the input for a Friday from Thursday's class and skips weekends", async () => {
    await sql`insert into class_logs (date, heavy_groups, source) values ('2026-10-01', ${sql.array(["legs"])}, 'import')`;
    const fri = await loadSessionInput(db, "2026-10-02");
    expect(fri?.weekday).toBe("fri");
    expect(fri?.heavyGroups).toEqual(["legs"]);
    expect(fri?.classReported).toBe(true);
    const fri2 = await loadSessionInput(db, "2026-10-09");
    expect(fri2?.classReported).toBe(false);
    expect(await loadSessionInput(db, "2026-10-04")).toBeNull();
    expect(await loadSessionInput(db, "2026-08-01")).toBeNull();
  });

  it("counts a class day as training for the 10-day rule", async () => {
    await logMondays([1]);
    await sql`insert into class_logs (date, heavy_groups, source) values ('2026-10-08', ${sql.array([])}, 'import')`;
    const input = await loadSessionInput(db, "2026-10-12");
    expect(input?.lastTrainingDate).toBe("2026-10-08");
  });
});
