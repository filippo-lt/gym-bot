import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildChart } from "../../src/charts/index.js";
import { loadExerciseChartData, loadVolumeRows } from "../../src/charts/load.js";
import { connect, exId, resetAndSeed } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function group(
  slug: string,
  date: string,
  sets: { reps: number; load: number; rir?: number }[],
) {
  const exerciseId = await exId(sql, slug);
  const [g] = await sql`
    insert into log_groups (session_date, performed_at, exercise_id, source)
    values (${date}, ${`${date}T08:00:00Z`}, ${exerciseId}, 'text') returning id`;
  for (const [i, s] of sets.entries()) {
    await sql`insert into log_entries (group_id, set_index, reps, load_kg, rir)
      values (${g?.id}, ${i + 1}, ${s.reps}, ${s.load}, ${s.rir ?? null})`;
  }
}

beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`update exercises set muscle_group = 'quads' where slug in ('squat', 'hack_squat')`;
  await sql`update exercises set muscle_group = 'back' where slug = 'pull_up'`;
  await group("squat", "2026-10-05", [
    { reps: 5, load: 80, rir: 2 },
    { reps: 5, load: 80 },
  ]);
  await group("squat", "2026-09-28", [{ reps: 5, load: 77.5, rir: 2 }]);
  await group("hack_squat", "2026-09-29", [{ reps: 10, load: 100, rir: 2 }]);
  await group("pull_up", "2026-10-06", [{ reps: 6, load: 0 }]);
});

describe("loadExerciseChartData", () => {
  it("returns the exercise's sessions oldest first, never another option's", async () => {
    const squat = await exId(sql, "squat");
    const data = await loadExerciseChartData(db, squat);
    expect(data?.name).toBe("squat");
    expect(data?.ex.id).toBe(squat);
    expect(data?.sessions.map((s) => s.date)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(data?.sessions.every((s) => s.exerciseId === squat)).toBe(true);
    expect(data?.sessions[0]?.week).toBe(1);
    expect(data?.sessions[1]?.week).toBe(2);
  });

  it("honours sinceDate", async () => {
    const data = await loadExerciseChartData(db, await exId(sql, "squat"), "2026-10-01");
    expect(data?.sessions.map((s) => s.date)).toEqual(["2026-10-05"]);
  });

  it("loads HSPU step names", async () => {
    const data = await loadExerciseChartData(db, await exId(sql, "hspu"));
    expect(data?.sessions).toEqual([]);
    expect(data?.stepNames.get(2)).toBe("partial_rom_wall_hspu");
  });

  it("is null for an unknown exercise", async () => {
    expect(await loadExerciseChartData(db, 999999)).toBeNull();
  });
});

describe("loadVolumeRows", () => {
  it("counts one set per log entry with the plan week and muscle group", async () => {
    const rows = await loadVolumeRows(db);
    const sum = (week: number, group: string) =>
      rows
        .filter((r) => r.week === week && r.muscleGroup === group)
        .reduce((a, r) => a + r.sets, 0);
    expect(sum(1, "quads")).toBe(2); // squat 1 + hack squat 1 (separate exercises, same muscle group)
    expect(sum(2, "quads")).toBe(2);
    expect(sum(2, "back")).toBe(1);
    expect(rows.find((r) => r.muscleGroup === "back")?.type).toBe("bodyweight_plus");
  });

  it("honours sinceDate", async () => {
    const rows = await loadVolumeRows(db, "2026-10-01");
    expect(rows.every((r) => r.week === 2)).toBe(true);
  });
});

describe("buildChart", () => {
  const NOW = new Date("2026-10-08T08:00:00Z");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  it("renders squat with two sessions", async () => {
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "squat"), metric: "auto" },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.png.subarray(0, 4).equals(PNG)).toBe(true);
      expect(r.caption).toContain("e1RM");
      expect(r.facts.sessions).toBe(2);
    }
  });

  it("is not_enough_data with one session", async () => {
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "pull_up"), metric: "auto" },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, reason: "not_enough_data" });
  });

  it("is no_numbers for a type without numbers", async () => {
    await sql`update exercises set type = 'skill_practice', load_basis = null where slug = 'face_pull'`;
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "face_pull"), metric: "auto" },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, reason: "no_numbers" });
  });

  it("is unknown_exercise for a missing id", async () => {
    const r = await buildChart(db, { kind: "exercise", exerciseId: 999999, metric: "auto" }, NOW);
    expect(r).toMatchObject({ ok: false, reason: "unknown_exercise" });
  });

  it("renders volume", async () => {
    const r = await buildChart(db, { kind: "volume" }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.png.subarray(0, 4).equals(PNG)).toBe(true);
  });

  it("honours metric reps and the weeks option", async () => {
    const squat = await exId(sql, "squat");
    const r = await buildChart(db, { kind: "exercise", exerciseId: squat, metric: "reps" }, NOW);
    expect(r.ok && r.caption).toContain("best set");
    // NOW is 2026-10-08: weeks 1 keeps only sessions on/after 2026-10-01, leaving one point.
    const w = await buildChart(
      db,
      { kind: "exercise", exerciseId: squat, metric: "auto", weeks: 1 },
      NOW,
    );
    expect(w).toMatchObject({ ok: false, reason: "not_enough_data" });
    expect(!w.ok && w.text).toContain("(1 session)");
  });

  it("notes the load -> reps fallback", async () => {
    await group("pull_up", "2026-10-13", [{ reps: 8, load: 0 }]);
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "pull_up"), metric: "load" },
      NOW,
    );
    // pull-ups have load math: "load" stays on e1RM (no bodyweight -> not enough), so use a reps-only exercise
    expect(r.ok).toBe(false);
    await sql`update exercises set type = 'bodyweight_reps', load_basis = null where slug = 'hack_squat'`;
    await group("hack_squat", "2026-10-06", [{ reps: 12, load: 0 }]);
    const h = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "hack_squat"), metric: "load" },
      NOW,
    );
    expect(h.ok && h.facts.note).toMatch(/No load math/);
  });

  it("notes the pull-up auto fallback to reps", async () => {
    await group("pull_up", "2026-10-13", [{ reps: 8, load: 0 }]);
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "pull_up"), metric: "auto" },
      NOW,
    );
    expect(r.ok && r.facts.note).toMatch(/showing most reps/);
  });

  it("charts a series that spans two years", async () => {
    await group("squat", "2025-10-06", [{ reps: 5, load: 70, rir: 2 }]);
    const r = await buildChart(
      db,
      { kind: "exercise", exerciseId: await exId(sql, "squat"), metric: "auto" },
      NOW,
    );
    expect(r.ok && r.caption).toContain("since 6 Oct 2025");
  });
});

describe("volume chart plan length", () => {
  it("a 13th plan week extends the domain past the old end", async () => {
    await sql`update plans set weeks = 12, start_date = '2026-09-28'`;
    await sql`
      insert into plan_weeks (plan_version_id, week, phase, is_deload, is_test, start_date)
      select plan_version_id, g, phase, is_deload, is_test, date '2026-09-28' + (g - 1) * 7
      from plan_weeks, generate_series(4, 13) g where week = 3`;
    const r = await buildChart(db, { kind: "volume" }, new Date("2027-01-15T10:00:00Z"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.facts.currentWeek).toBe(13);
  });
});
