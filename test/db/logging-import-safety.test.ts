import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appendMessage, recentMessages } from "../../src/logging/conversation.js";
import { executeActions, undoGroup } from "../../src/logging/execute.js";
import { buildPromptContext } from "../../src/logging/prompt-context.js";
import { stageEdit, stageLogSets } from "../../src/logging/resolve.js";
import type { LogSetsInput, StagedAction } from "../../src/logging/types.js";
import { connect, exId, MON, resetAndSeed, TUE } from "./logging-fixture.js";

const { sql, db } = connect();
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await resetAndSeed(db, sql);
  await sql`insert into bodyweight_logs (date, kg, source) values ('2026-09-28', 70, 'bot')`;
});

const bench = (over: Partial<LogSetsInput> = {}): LogSetsInput => ({
  exercise: { slug: "bench_press", said: "bench" },
  sets: { count: 2, reps: 6, load_kg: 55 },
  guessed_fields: [],
  needs_confirmation: false,
  ...over,
});

async function stage(
  i: LogSetsInput,
  now = MON,
): Promise<Extract<StagedAction, { kind: "log_sets" }>> {
  const r = await stageLogSets(db, i, now);
  if (!r.ok || r.action.kind !== "log_sets") throw new Error("expected a log_sets action");
  return r.action;
}

/** Monday's bench item id (week 1). */
const mondayBench = async () =>
  ((await sql`select id from planned_items where item_key = 'w01-mon-03-0'`)[0]?.id ?? 0) as number;

async function importRow(status: "done" | "skipped", chosen: number | null) {
  const id = await mondayBench();
  await sql`insert into session_items (session_date, planned_item_id, status, chosen_exercise_id, source, import_row_key) values ('2026-09-28', ${id}, ${status}, ${chosen}, 'import', 'k1')`;
  return id;
}

const items = () =>
  sql`select session_date::text as d, status, chosen_exercise_id, source, import_row_key from session_items order by id`;

describe("imported session_items vs bot logs", () => {
  it("a make-up never targets an item the import already marked done or skipped", async () => {
    await importRow("done", null);
    const a = await stage(bench(), TUE);
    expect(a.resolved).toMatchObject({ match: "unplanned", plannedItem: null });
    await sql`update session_items set status = 'skipped'`;
    expect((await stage(bench(), TUE)).resolved.match).toBe("unplanned");
  });

  it("a make-up still targets an open (planned) item", async () => {
    expect((await stage(bench(), TUE)).resolved).toMatchObject({
      match: "makeup",
      sessionDate: "2026-09-28",
    });
  });

  it.each(["done", "skipped"] as const)(
    "log on an imported %s row, then undo, leaves the row as it was",
    async (status) => {
      const squat = await exId(sql, "squat");
      await importRow(status, status === "done" ? squat : null);
      const before = await items();
      const a = await stage(bench());
      expect(a.resolved.match).toBe("today");
      const r = await executeActions(db, "u:1", [a], { now: MON });
      expect(r.status === "done" && r.results[0]).toMatchObject({
        kind: "log",
        sessionItemBefore: { status, source: "import" },
      });
      const [during] = await items();
      expect(during).toMatchObject({ status: "done", source: "import", import_row_key: "k1" });
      const groupId =
        r.status === "done" && r.results[0]?.kind === "log" ? r.results[0].groupId : 0;
      expect(await undoGroup(db, groupId)).not.toBeNull();
      expect(await items()).toEqual(before);
    },
  );

  it("log on an empty slot, then undo, deletes the bot row", async () => {
    const a = await stage(bench());
    const r = await executeActions(db, "u:2", [a], { now: MON });
    expect(await items()).toMatchObject([{ status: "done", source: "bot" }]);
    expect(r.status === "done" && r.results[0]).toMatchObject({ sessionItemBefore: null });
    const groupId = r.status === "done" && r.results[0]?.kind === "log" ? r.results[0].groupId : 0;
    await undoGroup(db, groupId);
    expect(await items()).toEqual([]);
  });

  it("a legacy ledger row without the field never deletes an import row", async () => {
    await importRow("done", null);
    const a = await stage(bench());
    const r = await executeActions(db, "u:3", [a], { now: MON });
    const groupId = r.status === "done" && r.results[0]?.kind === "log" ? r.results[0].groupId : 0;
    await sql`update write_ledger set result = ${JSON.stringify({ kind: "log", groupId })}::jsonb where source_key = 'u:3'`;
    await undoGroup(db, groupId);
    expect(await items()).toMatchObject([{ source: "import", import_row_key: "k1" }]);
  });
});

describe("same-item exercise edit (OR item)", () => {
  const orItem = async () =>
    ((await sql`select id from planned_items where item_key = 'w01-mon-04-0'`)[0]?.id ??
      0) as number;
  const squatInput = (slug: string): LogSetsInput => ({
    exercise: { slug, said: slug },
    sets: { count: 3, reps: 8, load_kg: 60 },
    guessed_fields: [],
    needs_confirmation: false,
  });

  async function logThenSwitch() {
    const a = await stage(squatInput("squat"));
    const r = await executeActions(db, "u:20", [a], { now: MON });
    const groupId = r.status === "done" && r.results[0]?.kind === "log" ? r.results[0].groupId : 0;
    const e = await stageEdit(
      db,
      { changes: { exercise_slug: "hack_squat" }, guessed_fields: [], needs_confirmation: false },
      MON,
    );
    if (!e.ok) throw new Error(e.error);
    await executeActions(db, "u:21", [e.action], { now: MON });
    return groupId;
  }

  it("undo after switching option on the same item restores the imported skipped row", async () => {
    const id = await orItem();
    await sql`insert into session_items (session_date, planned_item_id, status, source, import_row_key) values ('2026-09-28', ${id}, 'skipped', 'import', 'k2')`;
    const before = await items();
    const groupId = await logThenSwitch();
    expect((await items())[0]).toMatchObject({ status: "done", source: "import" });
    await undoGroup(db, groupId);
    expect(await items()).toEqual(before);
  });

  it("on an empty slot the bot row is deleted", async () => {
    const groupId = await logThenSwitch();
    await undoGroup(db, groupId);
    expect(await items()).toEqual([]);
  });
});

describe("explicit day today", () => {
  it("omitted day proposes the make-up, day today stays in today's plan", async () => {
    expect((await stage(bench(), TUE)).resolved.match).toBe("makeup");
    const t = await stage(bench({ day: "today" }), TUE);
    expect(t.resolved).toMatchObject({ match: "unplanned", plannedItem: null });
    expect(t.resolved.sessionDate).toBe("2026-09-29");
  });
});

describe("conversation history", () => {
  it("skips a repeated user message when it is the latest row, keeps it after a reply", async () => {
    await appendMessage(db, 7, "user", "bench 55");
    await appendMessage(db, 7, "user", "bench 55");
    expect(await recentMessages(db, 7, new Date())).toHaveLength(1);
    await appendMessage(db, 7, "assistant", "ok");
    await appendMessage(db, 7, "user", "bench 55");
    expect(await recentMessages(db, 7, new Date())).toHaveLength(3);
  });

  it("does not skip an identical message from long ago", async () => {
    await appendMessage(db, 7, "user", "undo");
    await sql`update conversation_messages set created_at = now() - interval '30 minutes'`;
    await appendMessage(db, 7, "user", "undo");
    expect(await sql`select 1 from conversation_messages`).toHaveLength(2);
  });

  it("the prompt lists the last saved bot logs, newest first, never imports", async () => {
    const a = await stage(bench());
    await executeActions(db, "u:9", [a], { now: MON });
    const sq = await stage(
      bench({
        exercise: { slug: "squat", said: "squat" },
        sets: { count: 3, reps: 5, load_kg: 80 },
      }),
    );
    await executeActions(db, "u:10", [sq], { now: new Date(MON.getTime() + 60_000) });
    const ctx = await buildPromptContext(db, 7, new Date(MON.getTime() + 120_000));
    expect(ctx.lastSaved.map((l) => l.summary)).toEqual([
      expect.stringContaining("3 × 5 · 80 kg"),
      expect.stringContaining("2 × 6 · 55 kg"),
    ]);
    expect(ctx.lastSaved[0]?.sessionDate).toBe("Mon 28 Sep");
  });
});
