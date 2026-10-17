import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOverrides } from "../../src/plan-import/apply-overrides.js";
import { buildPlan } from "../../src/plan-import/build-plan.js";
import {
  CATALOG,
  CATALOG_BY_SLUG,
  OR_PLAN_NAMES,
  PLAN_NAME_MAP,
} from "../../src/plan-import/exercise-catalog.js";
import { loadEquipment, loadHspuLadder } from "../../src/plan-import/load-seed.js";
import { collapsedRowLines, collapseItems, renderReview } from "../../src/plan-import/review.js";

const root = resolve(import.meta.dirname, "../..");
const rawBytes = readFileSync(resolve(root, "seed/hybrid-strength-plan.json"), "utf8");
const equipment = loadEquipment(resolve(root, "seed/equipment.json"));
const hspuLadder = loadHspuLadder(resolve(root, "seed/hspu-ladder.json"));
const plan = buildPlan(rawBytes, { equipment, hspuLadder });

describe("full plan file", () => {
  it("maps all 35 plan names, none unknown", () => {
    const names = new Set(
      (JSON.parse(rawBytes) as { weeks: { days: Record<string, { exercise: string }[]> }[] }).weeks
        .flatMap((w) => Object.values(w.days).flat())
        .map((e) => e.exercise),
    );
    expect(names.size).toBe(35);
    for (const n of names) expect(PLAN_NAME_MAP[n], n).toBeDefined();
    expect(plan.items.flatMap((i) => i.flags).filter((f) => f.code === "unknown_exercise")).toEqual(
      [],
    );
  });

  it("catalog slugs are unique and every option exists", () => {
    expect(new Set(CATALOG.map((c) => c.slug)).size).toBe(CATALOG.length);
    for (const e of Object.values(PLAN_NAME_MAP)) {
      for (const s of e.options) expect(CATALOG_BY_SLUG.has(s), s).toBe(true);
    }
  });

  it("every row parses or carries a flag", () => {
    for (const i of plan.items) {
      const parsedSomething = i.sets_min !== null || i.duration_s_min !== null || i.hiit !== null;
      const descriptive = i.exercise_options.every((s) =>
        ["warmup", "mobility", "recovery", "class", "skill_practice", "hiit"].includes(
          CATALOG_BY_SLUG.get(s)?.type ?? "",
        ),
      );
      expect(parsedSomething || descriptive || i.flags.length > 0, i.key).toBe(true);
    }
  });

  it("weeks and keys", () => {
    expect(plan.weeks[0]).toEqual({
      week: 1,
      phase: "Base",
      is_deload: false,
      is_test: false,
      start_date: "2026-09-28",
    });
    expect(plan.weeks[3]).toMatchObject({ is_deload: true, start_date: "2026-10-19" });
    expect(plan.weeks[11]).toMatchObject({ is_test: true, start_date: "2026-12-14" });
    expect(plan.items[0]?.key).toBe("w01-mon-00-0");
    expect(new Set(plan.items.map((i) => i.key)).size).toBe(plan.items.length);
    expect(plan.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("time parsing", () => {
    const byRaw = (raw: string) => plan.items.find((i) => i.time_raw === raw);
    expect(byRaw("12–16 min")).toMatchObject({ time_min_min: 12, time_min_max: 16 });
    expect(byRaw("Class")).toMatchObject({ time_min_min: null, time_min_max: null });
    expect(byRaw("5 min")).toMatchObject({ time_min_min: 5, time_min_max: 5 });
  });

  it("RIR on real rows", () => {
    const w4Bench = plan.items.find((i) => i.week === 4 && i.plan_name === "Bench press");
    expect(w4Bench).toMatchObject({ prescription_raw: "2 × 6 light", rir_min: 3, rir_max: 4 });
    const w12 = plan.items.find((i) => i.week === 12 && i.plan_name === "Easy press back-off");
    expect(w12).toMatchObject({
      rir_min: 3,
      rir_max: 4,
      exercise_options: ["overhead_press", "bench_press"],
    });
  });

  it("a '3-4 RIR' note never changes RIR", () => {
    const withNotes = plan.items.filter((i) => i.note && /RIR/.test(i.note));
    expect(withNotes.length).toBeGreaterThan(0);
    const bench = plan.items.find((i) => i.plan_name === "Bench press" && i.week === 1);
    expect(bench).toMatchObject({ rir_min: 1, rir_max: 2 });
    // Mutating notes must not alter RIR.
    const mutated = rawBytes.replace(/\d–\d RIR/g, "9–9 RIR");
    const other = buildPlan(mutated, { equipment, hspuLadder });
    expect(other.items.map((i) => [i.rir_min, i.rir_max])).toEqual(
      plan.items.map((i) => [i.rir_min, i.rir_max]),
    );
  });

  it("fallback on every pull-up item and nothing else", () => {
    for (const i of plan.items) {
      expect(i.fallback_prescription !== null, i.key).toBe(i.exercise_options.includes("pull_up"));
    }
    expect(plan.items.filter((i) => i.fallback_prescription).length).toBeGreaterThan(10);
  });

  it("OR items: 2+ options, only whitelisted names", () => {
    for (const i of plan.items) {
      if (OR_PLAN_NAMES.has(i.plan_name))
        expect(i.exercise_options.length).toBeGreaterThanOrEqual(2);
      else expect(i.exercise_options.length, i.plan_name).toBe(1);
    }
    expect(OR_PLAN_NAMES.size).toBe(5);
  });

  it("squat and hack squat are different exercises", () => {
    const item = plan.items.find((i) => i.plan_name === "Squat / hack squat");
    expect(item?.exercise_options).toEqual(["squat", "hack_squat"]);
    expect(plan.exercises.map((e) => e.slug)).toEqual(
      expect.arrayContaining(["squat", "hack_squat"]),
    );
  });

  it("deload variants carry the deload modifier", () => {
    const v = plan.items.filter(
      (i) => i.variant_label === "deload" || i.variant_label === "weighted_deload",
    );
    expect(v.length).toBeGreaterThan(0);
    for (const i of v) expect(i.modifiers, i.key).toContain("deload");
  });

  it("only referenced exercises are included", () => {
    const used = new Set(plan.items.flatMap((i) => i.exercise_options));
    expect(new Set(plan.exercises.map((e) => e.slug))).toEqual(used);
  });

  it("counts", () => {
    const resolved = applyOverrides(plan, { source_hash: plan.source_hash, items: {} });
    const rows = collapseItems(plan.items);
    const flagCounts: Record<string, number> = {};
    for (const i of plan.items)
      for (const f of i.flags) flagCounts[f.code] = (flagCounts[f.code] ?? 0) + 1;
    expect({
      items: plan.items.length,
      exercises: plan.exercises.length,
      collapsedRows: rows.length,
      flagCounts,
      openIssues: resolved.open_issues.length,
    }).toMatchInlineSnapshot(`
      {
        "collapsedRows": 87,
        "exercises": 32,
        "flagCounts": {
          "hspu_step_from_state": 7,
          "max_reps": 2,
          "missing_reps": 2,
          "optional_extra": 1,
        },
        "items": 323,
        "openIssues": 12,
      }
    `);
  });

  it("collapsed review rows", async () => {
    await expect(`${collapsedRowLines(plan.items).join("\n")}\n`).toMatchFileSnapshot(
      "./__snapshots__/review-rows.txt",
    );
  });

  it("review renders mapping table and bold flags", () => {
    const resolved = applyOverrides(plan, { source_hash: plan.source_hash, items: {} });
    const { markdown, csv } = renderReview(resolved);
    expect(markdown).toContain("## 3. Exercise mapping");
    expect(markdown).toContain("| Squat / hack squat | squat / hack_squat |");
    expect(markdown).toContain("**missing_reps**");
    expect(markdown).toContain("How to read this file");
    expect(markdown).toContain("322 plan rows + 1 extra set split out: w11-mon-01-1");
    expect(markdown).toContain(
      "| Weeks | Exercise | Raw | Parsed | Tags | Priority | Note | Time | Flags |",
    );
    expect(markdown).toContain("**hspu_step_from_state**");
    expect(csv.trim().split("\n").length).toBe(plan.items.length + 1);
  });
});
