import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executeActions, setLastSetRir, undoEdit, undoGroup } from "../../src/logging/execute.js";
import { deactivateMemory, saveAlias } from "../../src/logging/memory.js";
import { decidePolicy } from "../../src/logging/policy.js";
import {
  createLoggingBackend,
  resolveClarified,
  resolveLog,
  stageEdit,
  stageLogSets,
  stageUndoLast,
} from "../../src/logging/resolve.js";
import type { LogSetsInput, StagedAction } from "../../src/logging/types.js";
import { connect, exId, MON, resetAndSeed, SAT, TUE } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

const input = (over: Partial<LogSetsInput> = {}): LogSetsInput => ({
  exercise: { slug: "bench_press", said: "bench" },
  sets: { count: 2, reps: 6, load_kg: 55 },
  guessed_fields: [],
  needs_confirmation: false,
  ...over,
});

async function stage(i: LogSetsInput, now = MON): Promise<StagedAction> {
  const r = await stageLogSets(db, i, now);
  if (!r.ok) throw new Error(r.error);
  return r.action;
}

const count = async (table: string) =>
  ((await sql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? -1) as number;

describe("resolve", () => {
  it("matches today's planned item", async () => {
    const a = await stage(input());
    expect(a.kind).toBe("log_sets");
    if (a.kind !== "log_sets") return;
    expect(a.resolved).toMatchObject({
      match: "today",
      sessionDate: "2026-09-28",
      bwKg: 70,
      missingFields: [],
    });
    expect(a.resolved.plannedItem?.planName).toBe("Bench press");
    expect(decidePolicy([a])).toEqual({ mode: "direct" });
  });

  it("logs hack squat as hack_squat on the OR item, never squat", async () => {
    const a = await stage(input({ exercise: { slug: "hack_squat", said: "hack squat" } }));
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved.exercise.slug).toBe("hack_squat");
    expect(a.resolved.plannedItem?.planName).toBe("Squat / hack squat");
    await executeActions(db, "u:1", [a], { now: MON });
    const rows = await sql`
      select e.slug from log_groups g join exercises e on e.id = g.exercise_id`;
    expect(rows.map((r) => r.slug)).toEqual(["hack_squat"]);
    const [si] = await sql`select chosen_exercise_id from session_items`;
    expect(si?.chosen_exercise_id).toBe(await exId(sql, "hack_squat"));
  });

  it("resolves 'hack squat' by name without a slug", async () => {
    const r = await resolveLog(db, input({ exercise: { said: "Hack Squat" } }), MON);
    expect(r.kind === "ok" && r.log.exercise.slug).toBe("hack_squat");
  });

  it("asks which option when the user says the OR item's name", async () => {
    const r = await resolveLog(db, input({ exercise: { said: "squat / hack squat" } }), MON);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify")
      expect(r.candidates.map((c) => c.slug)).toEqual(["squat", "hack_squat"]);
  });

  it("trusts the user's exact words over a wrong slug (M2)", async () => {
    const a = await stage(input({ exercise: { slug: "squat", said: "hack squat" } }));
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved.exercise.slug).toBe("hack_squat");
    // the slug alone, or a slug that agrees with the words, still resolves directly
    const same = await stage(input({ exercise: { slug: "squat", said: "squat" } }));
    expect(same.kind === "log_sets" && same.resolved.exercise.slug).toBe("squat");
  });

  it("asks with both candidates when slug and words conflict without an exact match (M2)", async () => {
    const r = await resolveLog(
      db,
      input({ exercise: { slug: "squat", said: "hack squats" } }),
      MON,
    );
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify")
      expect(r.candidates.map((c) => c.slug)).toEqual(["squat", "hack_squat"]);
  });

  it("asks when the exercise is unknown, today's session first", async () => {
    const r = await resolveLog(db, input({ exercise: { said: "fp" } }), MON);
    expect(r.kind).toBe("clarify");
    if (r.kind !== "clarify") return;
    expect(r.candidates.length).toBeLessThanOrEqual(6);
    expect(r.candidates[0]?.slug).toBe("calisthenics_class");
    expect(r.candidates.map((c) => c.slug)).toContain("face_pull");
    const decision = decidePolicy([
      {
        kind: "clarify_exercise",
        input: input({ exercise: { said: "fp" } }),
        said: "fp",
        candidates: r.candidates,
      },
    ]);
    expect(decision).toEqual({ mode: "clarify", index: 0 });
  });

  it("gives a make-up the planned session date", async () => {
    // Tuesday: bench belongs to Monday's session and has no group yet.
    const a = await stage(input(), TUE);
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved).toMatchObject({ match: "makeup", sessionDate: "2026-09-28" });
    expect(decidePolicy([a])).toEqual({ mode: "confirm", reasons: ["makeup"] });
    await executeActions(db, "u:2", [a], { now: TUE });
    const [g] = await sql`select session_date::text as d, performed_at from log_groups`;
    expect(g?.d).toBe("2026-09-28");
    expect(new Date(String(g?.performed_at)).toISOString()).toBe(TUE.toISOString());
    const [si] = await sql`select session_date::text as d, status from session_items`;
    expect(si).toMatchObject({ d: "2026-09-28", status: "done" });
  });

  it("uses the named weekday for a make-up", async () => {
    const a = await stage(input({ day: "mon" }), TUE);
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved).toMatchObject({ match: "makeup", sessionDate: "2026-09-28" });
  });

  it("is unplanned when no day has the exercise, and on weekends", async () => {
    const a = await stage(input({ exercise: { slug: "face_pull", said: "face pull" } }));
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved).toMatchObject({
      match: "unplanned",
      plannedItem: null,
      sessionDate: "2026-09-28",
    });
    const w = await stage(input({ exercise: { slug: "face_pull", said: "face pull" } }), SAT);
    if (w.kind !== "log_sets") throw new Error("expected log");
    expect(w.resolved.match).toBe("unplanned");
    const wb = await stage(input(), SAT);
    if (wb.kind !== "log_sets") throw new Error("expected log");
    expect(wb.resolved).toMatchObject({ match: "makeup", sessionDate: "2026-09-28" });
  });

  it("flags missing fields", async () => {
    const a = await stage(input({ sets: [{ reps: 6 }] }));
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved.missingFields).toEqual(["load"]);
    expect(decidePolicy([a])).toEqual({ mode: "confirm", reasons: ["missing_field"] });
  });

  it("picks the item without a group when an exercise appears twice", async () => {
    const first = await stage(
      input({ exercise: { slug: "pull_up", said: "pull up" }, sets: { count: 3, reps: 5 } }),
    );
    if (first.kind !== "log_sets") throw new Error("expected log");
    expect(first.resolved.plannedItem?.planName).toBe("Clean strict pull-up");
    await executeActions(db, "u:3", [first], { now: MON });
    const second = await stage(
      input({ exercise: { slug: "pull_up", said: "pull up" }, sets: { count: 3, reps: 5 } }),
    );
    if (second.kind !== "log_sets") throw new Error("expected log");
    expect(second.resolved.plannedItem?.planName).toBe("Weighted pull-up");
  });

  it("uses the last session for the far-off reference, imports included", async () => {
    const [bench] = await sql`select id from exercises where slug = 'bench_press'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source, bw_kg) values ('2026-09-21', now(), ${bench?.id}, 'import', 70)`;
    const [g] = await sql`select id from log_groups`;
    await sql`insert into log_entries (group_id, set_index, reps, load_kg) values (${g?.id}, 1, 8, 50), (${g?.id}, 2, 6, 52.5)`;
    const a = await stage(input({ sets: { count: 2, reps: 6, load_kg: 100 } }));
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved.lastSession).toEqual({
      sessionDate: "2026-09-21",
      maxSystemLoad: 52.5,
      bestReps: 8,
    });
    expect(decidePolicy([a])).toEqual({ mode: "confirm", reasons: ["load_far_off"] });
  });
});

describe("HSPU step", () => {
  const hspu = (over: Partial<LogSetsInput> = {}) =>
    input({ exercise: { slug: "hspu", said: "hspu" }, sets: { count: 3, reps: 3 }, ...over });

  it("asks when there is no step anywhere", async () => {
    // Monday has no HSPU item, no earlier day does, and nothing is logged yet.
    const a = await stage(hspu(), MON);
    if (a.kind !== "log_sets") throw new Error("expected log");
    expect(a.resolved.missingFields).toContain("hspu_step");
    expect(a.resolved.hspuStep).toBeNull();
  });

  it("defaults to the planned item's step, then to the last logged step", async () => {
    const first = await stage(hspu(), TUE);
    if (first.kind !== "log_sets") throw new Error("expected log");
    expect(first.resolved.hspuStep?.slug).toBe("hspu_negative");
    const second = await stage(hspu({ hspu_step: "full_wall_hspu" }), TUE);
    if (second.kind !== "log_sets") throw new Error("expected log");
    expect(second.resolved.hspuStep?.slug).toBe("full_wall_hspu");
    await executeActions(db, "u:4", [second], { now: TUE });
    const third = await stage(hspu(), TUE);
    if (third.kind !== "log_sets") throw new Error("expected log");
    expect(third.resolved.hspuStep?.slug).toBe("full_wall_hspu");
    const [g] =
      await sql`select s.slug from log_groups g join hspu_ladder s on s.id = g.hspu_step_id`;
    expect(g?.slug).toBe("full_wall_hspu");
  });

  it("rejects an unknown step", async () => {
    const r = await stageLogSets(db, hspu({ hspu_step: "nope" }), TUE);
    expect(r.ok).toBe(false);
  });
});

describe("aliases", () => {
  it("saves an alias after a clarify, then resolves without asking", async () => {
    const i = input({ exercise: { said: "FP" }, sets: { count: 2, reps: 15, load_kg: 20 } });
    const staged = await stageLogSets(db, i, MON);
    expect(staged.ok && staged.action.kind).toBe("clarify_exercise");
    if (!staged.ok || staged.action.kind !== "clarify_exercise") return;
    const log = await resolveClarified(db, staged.action, "face_pull", MON);
    expect(log.resolved.exercise.slug).toBe("face_pull");
    await saveAlias(db, "FP", log.resolved.exercise.id);

    const again = await stageLogSets(db, i, MON);
    expect(again.ok && again.action.kind).toBe("log_sets");
    if (again.ok && again.action.kind === "log_sets") {
      expect(again.action.resolved.exercise.slug).toBe("face_pull");
    }
  });

  it("stops resolving a deactivated alias", async () => {
    const saved = await saveAlias(db, "fp", await exId(sql, "face_pull"));
    const i = input({ exercise: { said: "fp" } });
    expect((await resolveLog(db, i, MON)).kind).toBe("ok");
    await deactivateMemory(db, saved?.item.id as number);
    expect((await resolveLog(db, i, MON)).kind).toBe("clarify");
  });

  it("keeps one active alias per text", async () => {
    await saveAlias(db, "fp", await exId(sql, "face_pull"));
    await saveAlias(db, " FP! ", await exId(sql, "lateral_raise"));
    const rows =
      await sql`select active, structured->>'slug' as slug from memory_items order by id`;
    expect(rows.map((r) => [r.active, r.slug])).toEqual([
      [false, "face_pull"],
      [true, "lateral_raise"],
    ]);
  });
});

describe("edit and undo", () => {
  it("edits every set when they share a load, and restores on undoEdit", async () => {
    const a = await stage(input());
    await executeActions(db, "u:10", [a], { now: MON });
    const e = await stageEdit(
      db,
      { changes: { load_kg: 57.5 }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    expect(e.action.kind).toBe("edit_group");
    expect(decidePolicy([e.action])).toEqual({ mode: "direct" });
    const r = await executeActions(db, "u:11", [e.action], { now: MON });
    expect(r.status).toBe("done");
    const loads = async () =>
      (await sql`select load_kg::float8 as l from log_entries order by set_index`).map((x) => x.l);
    expect(await loads()).toEqual([57.5, 57.5]);
    await undoEdit(db, "u:11", 0);
    expect(await loads()).toEqual([55, 55]);
    await undoEdit(db, "u:11", 0);
    expect(await loads()).toEqual([55, 55]);
  });

  it("refuses to edit a mixed-load group without set indexes, writes nothing", async () => {
    const a = await stage(
      input({
        sets: [
          { reps: 6, load_kg: 50 },
          { reps: 6, load_kg: 55 },
        ],
      }),
    );
    await executeActions(db, "u:12", [a], { now: MON });
    const e = await stageEdit(
      db,
      { changes: { load_kg: 60 }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    expect(e).toEqual({
      ok: false,
      error: "The sets have different loads. Ask the user which sets to change.",
    });
    const ok = await stageEdit(
      db,
      { set_indexes: [2], changes: { load_kg: 60 }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    expect(ok.ok).toBe(true);
    expect(
      await sql`select load_kg::float8 as l from log_entries order by set_index`,
    ).toMatchObject([{ l: 50 }, { l: 55 }]);
  });

  it("puts an edited RIR on the last changed set and converts plates", async () => {
    const a = await stage(
      input({
        exercise: { slug: "squat", said: "squat" },
        sets: { count: 3, reps: 8, load_kg: 60 },
      }),
    );
    await executeActions(db, "u:13", [a], { now: MON });
    const e = await stageEdit(
      db,
      {
        changes: { plates_per_side_kg: 25, rir: 2 },
        guessed_fields: [],
        needs_confirmation: false,
      },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, "u:14", [e.action], { now: MON });
    const rows =
      await sql`select load_kg::float8 as l, rir::float8 as r from log_entries order by set_index`;
    expect(rows.map((r) => [r.l, r.r])).toEqual([
      [65, null],
      [65, null],
      [65, 2],
    ]);
  });

  it("says there is nothing to edit or undo", async () => {
    expect(
      await stageEdit(
        db,
        { changes: { reps: 5 }, guessed_fields: [], needs_confirmation: false },
        MON,
      ),
    ).toEqual({ ok: false, error: "Nothing to edit." });
    expect(await stageUndoLast(db, MON)).toEqual({ ok: false, error: "Nothing to undo." });
  });

  it("moves a group to another exercise and back on undo", async () => {
    const a = await stage(input({ exercise: { slug: "squat", said: "squat" } }));
    await executeActions(db, "u:15", [a], { now: MON });
    const e = await stageEdit(
      db,
      { changes: { exercise_slug: "hack_squat" }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, "u:16", [e.action], { now: MON });
    const slug = async () =>
      (await sql`select e.slug from log_groups g join exercises e on e.id = g.exercise_id`)[0]
        ?.slug;
    expect(await slug()).toBe("hack_squat");
    await undoEdit(db, "u:16", 0);
    expect(await slug()).toBe("squat");
  });

  it("undo removes the group and the bot session item", async () => {
    const a = await stage(input());
    const r = await executeActions(db, "u:20", [a], { now: MON });
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    expect(await count("session_items")).toBe(1);
    const snap = await undoGroup(db, r.results[0].groupId);
    expect(snap?.exercise.slug).toBe("bench_press");
    expect(await count("log_groups")).toBe(0);
    expect(await count("log_entries")).toBe(0);
    expect(await count("session_items")).toBe(0);
    expect(await undoGroup(db, r.results[0].groupId)).toBeNull();
  });

  it("undo keeps the session item when another group exists", async () => {
    const a = await stage(input());
    const r1 = await executeActions(db, "u:21", [a], { now: MON });
    await executeActions(db, "u:22", [a], { now: MON });
    if (r1.status !== "done" || r1.results[0]?.kind !== "log") throw new Error("expected log");
    await undoGroup(db, r1.results[0].groupId);
    expect(await count("log_groups")).toBe(1);
    expect(await count("session_items")).toBe(1);
  });

  it("undo keeps a session item that came from the import", async () => {
    const a = await stage(input());
    const r = await executeActions(db, "u:23", [a], { now: MON });
    await sql`update session_items set source = 'import'`;
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    await undoGroup(db, r.results[0].groupId);
    expect(await count("session_items")).toBe(1);
  });

  it("stages a delete of the most recent bot group", async () => {
    const a = await stage(input());
    await executeActions(db, "u:24", [a], { now: MON });
    const d = await stageUndoLast(db, MON);
    if (!d.ok) throw new Error(d.error);
    expect(decidePolicy([d.action])).toEqual({ mode: "confirm", reasons: ["delete"] });
    await executeActions(db, "u:25", [d.action], { now: MON });
    expect(await count("log_groups")).toBe(0);
    expect(await count("session_items")).toBe(0);
  });
});

describe("slug that doesn't fit the words (MAJOR-3)", () => {
  it("asks for 'fp' with slug squat, then follows the alias once it exists", async () => {
    const i = input({ exercise: { slug: "squat", said: "fp" } });
    const r = await stageLogSets(db, i, MON);
    expect(r.ok && r.action.kind).toBe("clarify_exercise");
    if (r.ok && r.action.kind === "clarify_exercise") {
      expect(r.action.candidates[0]?.slug).toBe("squat");
      expect(r.action.candidates.map((c) => c.slug)).toContain("face_pull");
    }
    await saveAlias(db, "fp", await exId(sql, "face_pull"));
    const again = await stageLogSets(db, i, MON);
    expect(
      again.ok && again.action.kind === "log_sets" && again.action.resolved.exercise.slug,
    ).toBe("face_pull");
  });

  it("still takes common phrasings with a slug without asking", async () => {
    for (const [said, slug] of [
      ["squats", "squat"],
      ["pull ups", "pull_up"],
      ["hack squat", "hack_squat"],
    ] as const) {
      const r = await resolveLog(
        db,
        input({ exercise: { slug, said }, sets: { count: 3, reps: 5 } }),
        MON,
      );
      expect(r.kind === "ok" && r.log.exercise.slug).toBe(slug);
    }
  });
});

describe("keys the exercise can't take (MINOR-4/7)", () => {
  const fails = async (i: LogSetsInput, field: string) => {
    const r = await stageLogSets(db, i, MON);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(field);
  };
  const pull = (sets: LogSetsInput["sets"]) =>
    input({ exercise: { slug: "pull_up", said: "pull up" }, sets });

  it("log_sets names the field instead of dropping it", async () => {
    await fails(input({ hspu_step: "hspu_negative" }), "hspu_step");
    await fails(input({ sets: [{ reps: 5, load_kg: 50, pad_height: 10 }] }), "pad_height");
    await fails(input({ sets: [{ reps: 5, load_kg: 50, band: "red" }] }), "band");
    await fails(pull({ count: 3, reps: 5, plates_per_side_kg: 10 }), "plates_per_side_kg");
    await fails(pull({ count: 3, reps: 5, pair_total_kg: 10 }), "pair_total_kg");
    await fails(input({ sets: [{ reps: 5, pair_total_kg: 40 }] }), "pair_total_kg");
    await fails(
      input({ exercise: { slug: "ring_row", said: "ring row" }, sets: [{ reps: 6, load_kg: 20 }] }),
      "load_kg",
    );
    expect((await stageLogSets(db, pull({ count: 3, reps: 5, band: "red" }), MON)).ok).toBe(true);
  });

  it("rejects clean on an exercise that can't take it (MINOR-1)", async () => {
    await fails(input({ clean: true }), "clean");
    expect((await stageLogSets(db, pull({ count: 3, reps: 5 }), MON)).ok).toBe(true);
    expect((await stageLogSets(db, { ...pull({ count: 3, reps: 5 }), clean: true }, MON)).ok).toBe(
      true,
    );
  });

  it("rejects conflicting load keys, naming both (MINOR-2)", async () => {
    await fails(
      input({ sets: [{ reps: 5, load_kg: 50, plates_per_side_kg: 10 }] }),
      "load_kg and plates_per_side_kg",
    );
    await fails(
      input({
        exercise: { slug: "lateral_raise", said: "lateral" },
        sets: [{ reps: 5, load_kg: 6, pair_total_kg: 12 }],
      }),
      "load_kg and pair_total_kg",
    );
    await fails(pull({ count: 3, reps: 5, added_kg: 10, load_kg: 10 }), "added_kg and load_kg");
    // different sets may use different forms
    expect(
      (
        await stageLogSets(
          db,
          input({
            sets: [
              { reps: 5, load_kg: 50 },
              { reps: 5, plates_per_side_kg: 10 },
            ],
          }),
          MON,
        )
      ).ok,
    ).toBe(true);
    await executeActions(db, "u:61", [await stage(input())], { now: MON });
    const e = await stageEdit(
      db,
      {
        changes: { load_kg: 60, plates_per_side_kg: 10 },
        guessed_fields: [],
        needs_confirmation: false,
      },
      MON,
    );
    expect(!e.ok && e.error).toContain("load_kg and plates_per_side_kg");
  });

  it("edits name them too", async () => {
    await executeActions(db, "u:60", [await stage(input())], { now: MON });
    for (const [changes, field] of [
      [{ hspu_step: "hspu_negative" }, "hspu_step"],
      [{ pad_height: 10 }, "pad_height"],
      [{ band: "red" }, "band"],
    ] as const) {
      const r = await stageEdit(
        db,
        { changes, guessed_fields: [], needs_confirmation: false } as never,
        MON,
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(field);
    }
  });
});

describe("edit validation", () => {
  const edit = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    stageEdit(
      db,
      { changes, guessed_fields: [], needs_confirmation: false, ...extra } as never,
      MON,
    );
  const log = async (
    slug: string,
    sets: LogSetsInput["sets"] = { count: 2, reps: 6, load_kg: 55 },
  ) =>
    executeActions(
      db,
      `u:${slug}`,
      [await stage(input({ exercise: { slug, said: slug }, sets }))],
      { now: MON },
    );

  it("names the right field when plates or a pair don't fit the equipment (m1)", async () => {
    await log("bench_press");
    const pair = await edit({ pair_total_kg: 40 });
    expect(pair.ok).toBe(false);
    expect(!pair.ok && pair.error).toContain("pair_total_kg");
    await sql`truncate log_entries, log_groups, session_items cascade`;
    await log("hack_squat");
    const plates = await edit({ plates_per_side_kg: 20 });
    expect(plates.ok).toBe(false);
    expect(!plates.ok && plates.error).toContain("plates_per_side_kg");
    expect(await count("log_entries")).toBe(2);
    expect(
      (await sql`select load_kg::float8 as l from log_entries order by set_index`).map((x) => x.l),
    ).toEqual([55, 55]);
  });

  it("rejects keys the exercise type can't take instead of dropping them (m2)", async () => {
    await log("bench_press");
    for (const [changes, field] of [
      [{ added_kg: 10 }, "added_kg"],
      [{ assist_kg: 10 }, "assist_kg"],
      [{ clean: true }, "clean"],
    ] as const) {
      const r = await edit(changes);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(field);
    }
    await sql`truncate log_entries, log_groups, session_items cascade`;
    await log("pull_up", { count: 3, reps: 5 });
    const plates = await edit({ plates_per_side_kg: 20 });
    expect(!plates.ok && plates.error).toContain("plates_per_side_kg");
    expect((await edit({ added_kg: 10 })).ok).toBe(true);
    await sql`truncate log_entries, log_groups, session_items cascade`;
    await log("ring_row", { count: 3, reps: 6 });
    const load = await edit({ load_kg: 20 });
    expect(!load.ok && load.error).toContain("load_kg");
  });

  it("applies clean only to the named sets (m2)", async () => {
    await log("pull_up", { count: 3, reps: 5 });
    const e = await edit({ clean: true }, { set_indexes: [2] });
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, "u:clean", [e.action], { now: MON });
    expect(
      (await sql`select clean from log_entries order by set_index`).map((x) => x.clean),
    ).toEqual([null, true, null]);
  });

  it("uses the planned reps_max as the far-off reps reference for edits (m9)", async () => {
    await log("bench_press");
    const e = await edit({ reps: 20 });
    if (!e.ok) throw new Error(e.error);
    expect(e.action.kind === "edit_group" && e.action.plannedRepsMax).toBe(8);
    expect(decidePolicy([e.action])).toEqual({ mode: "confirm", reasons: ["reps_far_off"] });
  });
});

describe("undo of an edit", () => {
  const loadsOf = async () =>
    (await sql`select load_kg::float8 as l from log_entries order by set_index`).map((x) => x.l);
  const editLoad = async (key: string, load: number) => {
    const e = await stageEdit(
      db,
      { changes: { load_kg: load }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, key, [e.action], { now: MON });
  };

  it("restores only what the edit changed; a RIR set later doesn't block (m3)", async () => {
    const r = await executeActions(db, "u:40", [await stage(input())], { now: MON });
    if (r.status !== "done" || r.results[0]?.kind !== "log") throw new Error("expected log");
    await editLoad("u:41", 57.5);
    await setLastSetRir(db, r.results[0].groupId, 2, false);
    expect((await undoEdit(db, "u:41", 0)).status).toBe("undone");
    expect(await loadsOf()).toEqual([55, 55]);
    const [last] = await sql`select rir::float8 as r from log_entries where set_index = 2`;
    expect(last?.r).toBe(2);
  });

  it("refuses when the log changed since, and writes nothing (m3)", async () => {
    await executeActions(db, "u:42", [await stage(input())], { now: MON });
    await editLoad("u:43", 57.5);
    await editLoad("u:44", 60);
    expect((await undoEdit(db, "u:43", 0)).status).toBe("stale");
    expect(await loadsOf()).toEqual([60, 60]);
    expect((await undoEdit(db, "u:44", 0)).status).toBe("undone");
    expect(await loadsOf()).toEqual([57.5, 57.5]);
  });

  it("puts the chosen exercise back on an OR item (m4)", async () => {
    await executeActions(
      db,
      "u:45",
      [await stage(input({ exercise: { slug: "squat", said: "squat" } }))],
      {
        now: MON,
      },
    );
    const e = await stageEdit(
      db,
      { changes: { exercise_slug: "hack_squat" }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, "u:46", [e.action], { now: MON });
    const chosen = async () =>
      (await sql`select chosen_exercise_id from session_items`)[0]?.chosen_exercise_id;
    expect(await chosen()).toBe(await exId(sql, "hack_squat"));
    expect((await undoEdit(db, "u:46", 0)).status).toBe("undone");
    expect(await chosen()).toBe(await exId(sql, "squat"));
  });
});

describe("backend with an open request (B1)", () => {
  it("refuses edit and undo while something is unsaved, and still stages log_sets", async () => {
    await executeActions(db, "u:50", [await stage(input())], { now: MON });
    const backend = createLoggingBackend(db, MON, { openPending: { summary: "Face pull 1 × 15" } });
    const e = await backend.stageEdit({
      changes: { load_kg: 22.5 },
      guessed_fields: [],
      needs_confirmation: false,
    });
    expect(e).toEqual({
      ok: false,
      error:
        "There is an unsaved request (Face pull 1 × 15). Restate the full corrected request with log_sets instead.",
    });
    const u = await backend.stageUndoLast({});
    expect(u.ok).toBe(false);
    expect((await backend.stageLogSets(input())).ok).toBe(true);
    const free = createLoggingBackend(db, MON, { openPending: null });
    expect((await free.stageUndoLast({})).ok).toBe(true);
  });
});

describe("backend", () => {
  it("returns a compact session without loads", async () => {
    const backend = createLoggingBackend(db, MON);
    const s = (await backend.getSession({ day: "today" })) as {
      kind: string;
      items: { name: string; options: string[]; status: string }[];
    };
    expect(s.kind).toBe("session");
    expect(s.items.find((i) => i.name === "Squat / hack squat")?.options).toEqual([
      "squat",
      "hack_squat",
    ]);
    expect(JSON.stringify(s)).not.toMatch(/"(load|loadKg|load_kg)"/);
    const tue = (await backend.getSession({ day: "tue" })) as { weekday: string };
    expect(tue.weekday).toBe("tue");
    const sat = createLoggingBackend(db, () => SAT);
    expect(((await sat.getSession({ day: "today" })) as { kind: string }).kind).toBe("rest_day");
  });
});
