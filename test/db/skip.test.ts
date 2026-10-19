import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { executeActions, undoGroup } from "../../src/logging/execute.js";
import { stageLogSets } from "../../src/logging/resolve.js";
import { loadSkipDay, skipAction, stageSkip, undoSkip } from "../../src/logging/skip.js";
import type { SkipItemsInput, SkipTarget } from "../../src/logging/types.js";
import { loadSessionAdvice } from "../../src/progression/session-advice.js";
import { connect, exId, MON, resetAndSeed, TUE } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

const DATE = "2026-09-28";
const itemId = async (order: number) =>
  ((await sql`select id from planned_items where item_key = ${`w01-mon-0${order}-0`}`)[0]?.id ??
    0) as number;
const BENCH = 3;
const ROW = 2;
const LATERAL = 6;

const target = async (order: number, priority: SkipTarget["priority"] = "High") => {
  const [r] = await sql`select plan_name from planned_items where id = ${await itemId(order)}`;
  return {
    plannedItemId: await itemId(order),
    planName: r?.plan_name as string,
    priority,
  } satisfies SkipTarget;
};

const rows = () =>
  sql`select session_date::text as d, planned_item_id, status, chosen_exercise_id, source from session_items order by planned_item_id`;

async function skip(key: string, targets: SkipTarget[], whole = false) {
  const r = await executeActions(db, key, [skipAction(DATE, whole, targets)], { now: MON });
  if (r.status !== "done" || r.results[0]?.kind !== "skip") throw new Error("expected a skip");
  return r.results[0];
}

async function logBench(key = "u:900") {
  const r = await stageLogSets(
    db,
    {
      exercise: { slug: "bench_press", said: "bench" },
      sets: { count: 2, reps: 6, load_kg: 55 },
      guessed_fields: [],
      needs_confirmation: false,
    },
    MON,
  );
  if (!r.ok) throw new Error(r.error);
  const e = await executeActions(db, key, [r.action], { now: MON });
  return e.status === "done" && e.results[0]?.kind === "log" ? e.results[0].groupId : 0;
}

describe("skip labels", () => {
  it("name an HSPU item with its ladder step, like /today", async () => {
    const { open } = await loadSkipDay(db, "2026-09-29");
    const hspu = open.find((t) => t.planName === "HSPU progression");
    expect(hspu?.label).toBe("HSPU — hspu_negative");
  });

  const hspuOn = async (date: string, today: string) =>
    (await loadSkipDay(db, date, today)).open.find((t) => t.planName === "HSPU progression");

  it("an HSPU item on a future day shows the plan's step, like /today", async () => {
    const [step] = await sql`select id from hspu_ladder where slug = 'full_wall_hspu'`;
    await sql`insert into log_groups (session_date, performed_at, exercise_id, source, hspu_step_id)
      values ('2026-09-29', '2026-09-29T08:00:00Z', ${await exId(sql, "hspu")}, 'text', ${step?.id})`;
    // /today for a later day is plan text only (no advice)
    expect(await loadSessionAdvice(db, "2026-10-06", TUE)).toBeNull();
    expect((await hspuOn("2026-10-06", "2026-09-29"))?.label).toBe("HSPU — hspu_negative");
  });

  it("an accepted advance counts as the current step today, like /today", async () => {
    await sql`insert into proposals (kind, payload, status, decided_at)
      values ('hspu_advance', ${JSON.stringify({ toStepOrder: 2 })}::jsonb, 'accepted', '2026-09-29T07:00:00Z')`;
    const label = (await hspuOn("2026-09-29", "2026-09-29"))?.label;
    expect(label).toBe("HSPU — partial_rom_wall_hspu");
    const advice = await loadSessionAdvice(db, "2026-09-29", TUE);
    const id = (await hspuOn("2026-09-29", "2026-09-29"))?.plannedItemId as number;
    expect(advice?.items.get(id)?.hspuStep?.name).toBe("partial_rom_wall_hspu");
    // another day still shows the plan's step
    expect((await hspuOn("2026-10-06", "2026-09-29"))?.label).toBe("HSPU — hspu_negative");
  });
});

describe("loadSkipDay", () => {
  it("lists planned items and leaves out done, skipped and logged ones", async () => {
    const all = (await loadSkipDay(db, DATE)).open;
    expect(all.map((t) => t.planName)).toContain("Bench press");
    await sql`insert into session_items (session_date, planned_item_id, status, source) values (${DATE}, ${await itemId(ROW)}, 'done', 'import')`;
    await sql`insert into session_items (session_date, planned_item_id, status, source) values (${DATE}, ${await itemId(LATERAL)}, 'skipped', 'import')`;
    await logBench();
    const open = (await loadSkipDay(db, DATE)).open.map((t) => t.planName);
    expect(open).not.toContain("Bench press");
    expect(open).not.toContain("Chest-supported row");
    expect(open).not.toContain("Lateral raise");
    expect(open).toContain("Cable row");
  });

  it("is empty on a weekend", async () => {
    expect((await loadSkipDay(db, "2026-10-03")).open).toEqual([]);
  });
});

describe("skip write and undo", () => {
  it("writes a bot row, and Undo deletes it", async () => {
    const r = await skip("u:1", [await target(BENCH)]);
    expect(r.items).toEqual([expect.objectContaining({ planName: "Bench press", before: null })]);
    expect(await rows()).toMatchObject([
      { status: "skipped", source: "bot", chosen_exercise_id: null },
    ]);
    expect(await undoSkip(db, "u:1", 0)).toEqual({ status: "undone", names: ["Bench press"] });
    expect(await rows()).toEqual([]);
  });

  it("over an imported 'planned' row keeps source import, and Undo restores it", async () => {
    await sql`insert into session_items (session_date, planned_item_id, status, source, import_row_key) values (${DATE}, ${await itemId(BENCH)}, 'planned', 'import', 'k1')`;
    const before = await rows();
    const r = await skip("u:2", [await target(BENCH)]);
    expect(r.items[0]?.before).toMatchObject({ status: "planned", source: "import" });
    expect(await rows()).toMatchObject([{ status: "skipped", source: "import" }]);
    await undoSkip(db, "u:2", 0);
    expect(await rows()).toEqual(before);
  });

  it("leaves done, logged and skipped items untouched at write time", async () => {
    const bench = await target(BENCH);
    const row = await target(ROW);
    const lateral = await target(LATERAL);
    const cable = await target(7);
    await logBench();
    await sql`insert into session_items (session_date, planned_item_id, status, source) values (${DATE}, ${row.plannedItemId}, 'done', 'import')`;
    await sql`insert into session_items (session_date, planned_item_id, status, source) values (${DATE}, ${lateral.plannedItemId}, 'skipped', 'import')`;
    const r = await skip("u:3", [bench, row, lateral, cable], true);
    expect(r.items.map((i) => i.planName)).toEqual(["Cable row"]);
    const byItem = Object.fromEntries((await rows()).map((x) => [x.planned_item_id, x]));
    expect(byItem[bench.plannedItemId]).toMatchObject({ status: "done", source: "bot" });
    expect(byItem[row.plannedItemId]).toMatchObject({ status: "done", source: "import" });
    expect(byItem[lateral.plannedItemId]).toMatchObject({ status: "skipped", source: "import" });
    expect(byItem[cable.plannedItemId]).toMatchObject({ status: "skipped", source: "bot" });
  });

  it("a retried executeActions with the same key writes nothing twice", async () => {
    const a = skipAction(DATE, false, [await target(BENCH)]);
    const first = await executeActions(db, "u:4", [a], { now: MON });
    await undoSkip(db, "u:4", 0);
    const retry = await executeActions(db, "u:4", [a], { now: MON });
    expect(retry).toEqual(first);
    expect(await rows()).toEqual([]);
  });

  it("Undo after the item was logged leaves it done", async () => {
    await skip("u:5", [await target(BENCH)]);
    await logBench();
    expect(await rows()).toMatchObject([{ status: "done" }]);
    expect(await undoSkip(db, "u:5", 0)).toEqual({ status: "none" });
    expect(await rows()).toMatchObject([{ status: "done" }]);
  });

  it("a repeated Undo does nothing", async () => {
    await skip("u:6", [await target(BENCH), await target(ROW)], true);
    expect(await undoSkip(db, "u:6", 0)).toMatchObject({ status: "undone" });
    expect(await undoSkip(db, "u:6", 0)).toEqual({ status: "none" });
    expect(await undoSkip(db, "u:6", 5)).toEqual({ status: "none" });
  });

  it("logging after a skip, then undoing the log, returns the item to skipped", async () => {
    await skip("u:7", [await target(BENCH)]);
    const groupId = await logBench();
    expect(await rows()).toMatchObject([{ status: "done" }]);
    await undoGroup(db, groupId);
    expect(await rows()).toMatchObject([{ status: "skipped", source: "bot" }]);
  });
});

describe("stageSkip", () => {
  const stage = (input: SkipItemsInput, now = MON) => stageSkip(db, input, now);
  const staged = async (input: SkipItemsInput, now = MON, day?: SkipItemsInput["day"]) => {
    const r = await stage(day ? { ...input, day } : input, now);
    if (!r.ok || r.action.kind !== "skip_items") throw new Error(r.ok ? "wrong kind" : r.error);
    return r;
  };

  it("matches by said and by slug", async () => {
    const bySaid = await staged({ exercise: { said: "bench" } });
    expect(bySaid.action).toMatchObject({
      kind: "skip_items",
      sessionDate: DATE,
      whole: false,
      items: [{ planName: "Bench press" }],
    });
    expect(bySaid.preview).toContain("Staged skip of Bench press for Mon 28 Sep.");
    const bySlug = await staged({ exercise: { slug: "lateral_raise", said: "side raises" } });
    expect(bySlug.action).toMatchObject({ items: [{ planName: "Lateral raise" }] });
  });

  it("matches an OR item by its plan name", async () => {
    const r = await staged({ exercise: { said: "squat / hack squat" } });
    expect(r.action).toMatchObject({ items: [{ planName: "Squat / hack squat" }] });
  });

  it("takes the day from the input", async () => {
    const r = await staged({ exercise: { said: "hack squat solo" }, day: "tue" }, MON);
    expect(r.action).toMatchObject({ sessionDate: "2026-09-29" });
    expect((await staged({ whole_session: true }, TUE)).action).toMatchObject({
      sessionDate: "2026-09-29",
      whole: true,
      items: [{ planName: "Hack squat solo" }, { planName: "HSPU progression" }],
    });
  });

  it("marks another day as needing a card, today as not", async () => {
    expect(
      (await staged({ exercise: { said: "hack squat solo" }, day: "tue" })).action,
    ).toMatchObject({
      otherDay: true,
    });
    expect((await staged({ whole_session: true }, TUE)).action).not.toHaveProperty("otherDay");
    expect((await staged({ whole_session: true }, TUE, "mon")).action).toMatchObject({
      otherDay: true,
    });
    expect((await staged({ exercise: { said: "bench" } })).action).not.toHaveProperty("otherDay");
  });

  it("flags several open matches as ambiguous and takes the first; plan names narrow", async () => {
    const both = await staged({ exercise: { slug: "pull_up", said: "pull ups" } });
    expect(both.action).toMatchObject({
      ambiguous: true,
      items: [{ planName: "Clean strict pull-up" }],
    });
    const narrowed = await staged({ exercise: { slug: "pull_up", said: "weighted pull-up" } });
    expect(narrowed.action).toMatchObject({ items: [{ planName: "Weighted pull-up" }] });
    expect(narrowed.action).not.toHaveProperty("ambiguous");
  });

  it("fails for a named day when the plan has no week for today", async () => {
    const after = new Date("2026-12-01T08:00:00Z");
    const r = await stage({ exercise: { said: "bench" }, day: "mon" }, after);
    expect(!r.ok && r.error).toBe("No plan week for mon.");
    const today = await stage({ whole_session: true }, after);
    expect(!today.ok && today.error).toContain("Nothing open to skip");
  });

  it("names the open items when nothing matches", async () => {
    const r = await stage({ exercise: { said: "zottman curl" } });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('No open item matches "zottman curl" on Mon 28 Sep.');
    expect(!r.ok && r.error).toContain("Open items: Warm-up, ");
    expect(!r.ok && r.error).toContain("Ask the user which one.");
  });

  it("errors for an item that is already logged or skipped", async () => {
    await logBench();
    const logged = await stage({ exercise: { slug: "bench_press", said: "bench" } });
    expect(!logged.ok && logged.error).toContain("already logged");
    await skip("u:8", [await target(LATERAL)]);
    const skipped = await stage({ exercise: { slug: "lateral_raise", said: "lateral" } });
    expect(!skipped.ok && skipped.error).toContain("already skipped");
  });

  it("whole session takes every open item, and errors when none is open", async () => {
    const r = await staged({ whole_session: true });
    expect(r.action.kind === "skip_items" && r.action.items).toHaveLength(9);
    await sql`insert into session_items (session_date, planned_item_id, status, source) select ${DATE}, id, 'done', 'import' from planned_items where week = 1 and weekday = 'mon'`;
    const none = await stage({ whole_session: true });
    expect(!none.ok && none.error).toBe("Nothing open to skip on Mon 28 Sep.");
    const rest = await stage({ whole_session: true }, new Date("2026-10-03T08:00:00Z"));
    expect(!rest.ok && rest.error).toBe("Nothing open to skip on Sat 3 Oct.");
  });
});
