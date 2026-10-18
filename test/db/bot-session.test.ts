import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSession, getWeek } from "../../src/bot/session.js";
import * as schema from "../../src/db/schema/index.js";
import { seedPlan } from "../../src/db/seed-plan.js";
import {
  applyOverrides,
  buildPlan,
  loadEquipment,
  loadHspuLadder,
  loadOverrides,
  readPlanFile,
} from "../../src/plan-import/index.js";
import { testDatabaseUrl } from "./constants.js";

const sql = postgres(testDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql, { schema });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function itemId(week: number, weekday: "mon" | "tue" | "wed" | "thu" | "fri", order: number) {
  const rows = await db
    .select({
      id: schema.plannedItems.id,
      order: schema.plannedItems.itemOrder,
      w: schema.plannedItems.week,
      d: schema.plannedItems.weekday,
      s: schema.plannedItems.subItem,
    })
    .from(schema.plannedItems);
  const row = rows.find((r) => r.w === week && r.d === weekday && r.order === order && r.s === 0);
  if (!row) throw new Error("item not found");
  return row.id;
}

beforeAll(async () => {
  await sql`truncate table planned_item_options, planned_items, plan_weeks, plan_versions, plans, hspu_ladder, exercises, equipment, class_logs restart identity cascade`;
  const resolved = applyOverrides(
    buildPlan(readPlanFile("seed/hybrid-strength-plan.json"), {
      equipment: loadEquipment("seed/equipment.json"),
      hspuLadder: loadHspuLadder("seed/hspu-ladder.json"),
    }),
    loadOverrides("seed/plan-overrides.json"),
  );
  expect(resolved.open_issues).toEqual([]);
  await seedPlan(db, resolved);

  // W1 Monday: item 1 done, item 2 skipped, item 3 modified. W1 Tuesday: item 1 done.
  const rows = [
    {
      sessionDate: "2026-09-28",
      plannedItemId: await itemId(1, "mon", 1),
      status: "done" as const,
    },
    {
      sessionDate: "2026-09-28",
      plannedItemId: await itemId(1, "mon", 2),
      status: "skipped" as const,
    },
    {
      sessionDate: "2026-09-28",
      plannedItemId: await itemId(1, "mon", 3),
      status: "modified" as const,
    },
    {
      sessionDate: "2026-09-29",
      plannedItemId: await itemId(1, "tue", 1),
      status: "done" as const,
    },
    // wrong date for this planned item: must not count in the week overview
    {
      sessionDate: "2026-10-06",
      plannedItemId: await itemId(1, "tue", 2),
      status: "done" as const,
    },
  ];
  await db.insert(schema.sessionItems).values(rows.map((r) => ({ ...r, source: "bot" as const })));
  await db.insert(schema.classLogs).values({
    date: "2026-10-01",
    heavyGroups: ["pull", "push"],
    source: "bot",
  });
});

describe("getSession", () => {
  it("returns Monday items with options and statuses", async () => {
    const s = await getSession(db, "2026-09-28");
    if (s.kind !== "session") throw new Error("expected session");
    expect(s).toMatchObject({
      week: 1,
      phase: "Base",
      weekday: "mon",
      focus: "Pull + hinge",
      isDeload: false,
    });
    expect(s.thursday).toBeUndefined();
    const mains = s.items.filter((i) => i.subItem === 0);
    expect(mains.map((i) => i.status).slice(0, 4)).toEqual([
      "planned",
      "done",
      "skipped",
      "modified",
    ]);
    expect(s.items.map((i) => i.itemOrder)).toEqual(
      [...s.items.map((i) => i.itemOrder)].sort((a, b) => a - b),
    );
    const pullup = mains.find((i) => i.tags.includes("skill_strength"));
    expect(pullup?.fallback).not.toBeNull();
    expect(pullup?.options.length).toBe(1);
  });

  it("returns OR options in order", async () => {
    const s = await getSession(db, "2026-10-02");
    if (s.kind !== "session") throw new Error("expected session");
    const squat = s.items.find((i) => i.tags.includes("squat"));
    expect(squat?.options.map((o) => o.slug)).toEqual(["squat", "hack_squat"]);
  });

  it("Friday carries Thursday heavy groups", async () => {
    const s = await getSession(db, "2026-10-02");
    if (s.kind !== "session") throw new Error("expected session");
    expect(s.thursday).toEqual({ heavy: ["pull", "push"] });
  });

  it("Friday without a class log is not_reported", async () => {
    const s = await getSession(db, "2026-10-09");
    if (s.kind !== "session") throw new Error("expected session");
    expect(s.thursday).toBe("not_reported");
  });

  it("deload flag in W4", async () => {
    const s = await getSession(db, "2026-10-20");
    if (s.kind !== "session") throw new Error("expected session");
    expect(s.isDeload).toBe(true);
    expect(s.week).toBe(4);
  });

  it("rest on weekends, before start, after the last week", async () => {
    expect(await getSession(db, "2026-10-25")).toEqual({
      kind: "rest",
      date: "2026-10-25",
      week: 4,
      phase: "Deload",
    });
    expect(await getSession(db, "2026-09-27")).toEqual({
      kind: "before_start",
      startDate: "2026-09-28",
    });
    expect(await getSession(db, "2026-12-21")).toEqual({ kind: "finished" });
  });
});

describe("getWeek", () => {
  it("counts statuses per day, matching on date", async () => {
    const w = await getWeek(db, "2026-10-01");
    if (w.kind !== "week") throw new Error("expected week");
    expect(w).toMatchObject({ week: 1, phase: "Base", startDate: "2026-09-28" });
    expect(w.days.map((d) => d.weekday)).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(w.days[0]).toMatchObject({
      date: "2026-09-28",
      focus: "Pull + hinge",
      done: 1,
      skipped: 1,
      modified: 1,
    });
    expect(w.days[0]?.total).toBeGreaterThan(3);
    expect(w.days[1]).toMatchObject({ date: "2026-09-29", done: 1, skipped: 0 });
    expect(w.days[2]).toMatchObject({ done: 0 });
    // Thursday: only the class item counts, not "Thursday exposure".
    expect(w.days[3]?.total).toBe(1);
  });

  it("works from a weekend date and handles bounds", async () => {
    const w = await getWeek(db, "2026-10-25");
    if (w.kind !== "week") throw new Error("expected week");
    expect(w.week).toBe(4);
    expect(w.isDeload).toBe(true);
    expect(await getWeek(db, "2026-09-20")).toEqual({
      kind: "before_start",
      startDate: "2026-09-28",
    });
    expect(await getWeek(db, "2027-01-01")).toEqual({ kind: "finished" });
  });
});
