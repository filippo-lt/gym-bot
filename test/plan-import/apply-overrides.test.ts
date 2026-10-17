import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOverrides } from "../../src/plan-import/apply-overrides.js";
import { buildPlan } from "../../src/plan-import/build-plan.js";
import { loadEquipment, loadHspuLadder } from "../../src/plan-import/load-seed.js";
import type { PlanOverrides } from "../../src/plan-import/types.js";

const root = resolve(import.meta.dirname, "../..");
const rawBytes = readFileSync(resolve(root, "seed/hybrid-strength-plan.json"), "utf8");
const equipment = loadEquipment(resolve(root, "seed/equipment.json"));
const hspuLadder = loadHspuLadder(resolve(root, "seed/hspu-ladder.json"));
const plan = buildPlan(rawBytes, { equipment, hspuLadder });
const blankPlan = {
  ...plan,
  equipment: plan.equipment.map((e) => ({
    ...e,
    base_kg: null,
    step_kg: null,
    discrete_values: null,
    bands: null,
  })),
  hspu_ladder: plan.hspu_ladder.map((l) =>
    l.slug === "full_wall_hspu" || l.slug === "lower_pad_wall_hspu"
      ? { ...l, default_sets: null, default_reps_min: null, default_reps_max: null }
      : l,
  ),
};
const withNotes = {
  ...plan,
  exercises: plan.exercises.map((e) =>
    e.slug === "triceps_extension" || e.slug === "ring_row"
      ? { ...e, review_note: `check ${e.slug}` }
      : e,
  ),
};
const none = { source_hash: plan.source_hash, items: {} };

describe("applyOverrides", () => {
  it("lists every remaining item flag", () => {
    const r = applyOverrides(plan, none);
    const flagCount = plan.items.reduce((n, i) => n + i.flags.length, 0);
    expect(r.open_issues.filter((o) => o.scope === "item").length).toBe(flagCount);
  });

  it("resolve removes a flag and merges fields", () => {
    const key = "w12-mon-02-0";
    const r = applyOverrides(plan, {
      source_hash: plan.source_hash,
      items: { [key]: { reps_min: 10, reps_max: 10, resolve: ["missing_reps"] } },
    });
    const item = r.plan.items.find((i) => i.key === key);
    expect(item).toMatchObject({ reps_min: 10, reps_max: 10, flags: [] });
    expect(r.open_issues.some((o) => o.ref === key)).toBe(false);
  });

  it("wrong hash is an issue", () => {
    const r = applyOverrides(plan, { source_hash: "nope", items: {} });
    expect(r.open_issues).toContainEqual(
      expect.objectContaining({ scope: "plan", ref: "source_hash" }),
    );
  });

  it("unknown override key is an issue", () => {
    const r = applyOverrides(plan, {
      source_hash: plan.source_hash,
      items: { "w99-mon-00-0": { resolve: [] } },
    });
    expect(r.open_issues).toContainEqual(expect.objectContaining({ ref: "w99-mon-00-0" }));
  });

  it("null equipment values and ladder defaults are issues; filled ones are not", () => {
    const r = applyOverrides(blankPlan, none);
    const eq = r.open_issues.filter((o) => o.scope === "equipment").map((o) => o.ref);
    expect(eq).toEqual(expect.arrayContaining(["barbell", "dumbbells", "pullup"]));
    expect(r.open_issues.filter((o) => o.scope === "hspu_ladder").map((o) => o.ref)).toEqual([
      "lower_pad_wall_hspu",
      "full_wall_hspu",
    ]);
    const filled = applyOverrides(
      { ...blankPlan, equipment: blankPlan.equipment.map((e) => ({ ...e, step_kg: 2.5 })) },
      none,
    );
    expect(
      filled.open_issues.filter((o) => o.scope === "equipment" && o.detail.includes("step_kg")),
    ).toEqual([]);
  });

  it("exercise review notes are issues", () => {
    expect(applyOverrides(plan, none).open_issues.filter((o) => o.scope === "exercise")).toEqual(
      [],
    );
    const r = applyOverrides(withNotes, none);
    expect(
      r.open_issues
        .filter((o) => o.scope === "exercise")
        .map((o) => o.ref)
        .sort(),
    ).toEqual(["ring_row", "triceps_extension"]);
  });

  it("acknowledge clears the exercise issue and applies fields", () => {
    const r = applyOverrides(withNotes, {
      source_hash: plan.source_hash,
      items: {},
      exercises: {
        triceps_extension: {
          acknowledge: true,
          equipment_slug: "dumbbells",
          load_basis: "per_hand",
        },
        ring_row: { acknowledge: true, muscle_group: "lats" },
      },
    });
    expect(r.open_issues.filter((o) => o.scope === "exercise")).toEqual([]);
    const row = r.plan.exercises.find((e) => e.slug === "ring_row");
    expect(row).toMatchObject({ muscle_group: "lats", review_note: null });
    const tri = r.plan.exercises.find((e) => e.slug === "triceps_extension");
    expect(tri).toMatchObject({
      equipment_slug: "dumbbells",
      load_basis: "per_hand",
      review_note: null,
    });
  });

  it("unknown exercise override slug is an issue", () => {
    const r = applyOverrides(plan, {
      source_hash: plan.source_hash,
      items: {},
      exercises: { nope: { acknowledge: true } },
    });
    expect(r.open_issues).toContainEqual(
      expect.objectContaining({ scope: "exercise", ref: "nope" }),
    );
  });

  it("hack squat has no review note", () => {
    expect(plan.exercises.find((e) => e.slug === "hack_squat")?.review_note).toBeNull();
  });

  it("seed files leave no open issues once accepted", () => {
    const overrides = JSON.parse(
      readFileSync(resolve(root, "seed/plan-overrides.json"), "utf8"),
    ) as PlanOverrides;
    expect(applyOverrides(plan, overrides).open_issues).toEqual([]);
  });

  const key = "w01-mon-01-0";
  const bad = (o: Record<string, unknown>) =>
    applyOverrides(plan, { source_hash: plan.source_hash, items: { [key]: o as never } });
  const mentions = (r: ReturnType<typeof bad>, text: string) =>
    r.open_issues.some((o) => o.ref === key && o.detail.includes(text));

  it("unknown override field is an issue", () => {
    expect(mentions(bad({ resolve: [], bogus: 1 }), "bogus")).toBe(true);
  });

  it("identity field is an issue", () => {
    for (const f of ["key", "week", "weekday", "order", "sub_item", "flags"]) {
      expect(mentions(bad({ resolve: [], [f]: 1 }), f), f).toBe(true);
    }
  });

  it("OR options on a non-whitelisted item is an issue", () => {
    expect(
      mentions(
        bad({ resolve: [], exercise_options: ["pull_up", "lat_pulldown"] }),
        "not an OR item",
      ),
    ).toBe(true);
  });

  it("unknown option slug and bad hspu slug are issues", () => {
    expect(mentions(bad({ resolve: [], exercise_options: ["nope"] }), "nope")).toBe(true);
    expect(mentions(bad({ resolve: [], hspu_step: "nope" }), "not a ladder step")).toBe(true);
    expect(mentions(bad({ resolve: [], hspu_step: "hspu_negative" }), "ladder step")).toBe(false);
  });

  it("resolved_hash is stable, changes with an override, ignores equipment", () => {
    const a = applyOverrides(plan, none).resolved_hash;
    expect(applyOverrides(plan, none).resolved_hash).toBe(a);
    const o = (reps: number) => ({
      source_hash: plan.source_hash,
      items: { "w12-mon-02-0": { reps_min: reps, reps_max: reps, resolve: [] } },
    });
    const b = applyOverrides(plan, o(8) as never).resolved_hash;
    expect(b).not.toBe(a);
    expect(applyOverrides(plan, o(8) as never).resolved_hash).toBe(b);
    expect(applyOverrides(plan, o(9) as never).resolved_hash).not.toBe(b);
    const eq = applyOverrides(
      { ...plan, equipment: plan.equipment.map((e) => ({ ...e, step_kg: 1 })) },
      none,
    ).resolved_hash;
    expect(eq).toBe(a);
  });

  it("base_kg and bands are flagged", () => {
    const eq = applyOverrides(blankPlan, none).open_issues.filter((o) => o.scope === "equipment");
    expect(eq.some((o) => o.ref === "barbell" && o.detail.includes("base_kg"))).toBe(true);
    expect(eq.some((o) => o.ref === "pullup" && o.detail.includes("bands"))).toBe(true);
    for (const bands of [{}, { red: 10 }] as Record<string, number>[]) {
      const filled = applyOverrides(
        {
          ...blankPlan,
          equipment: blankPlan.equipment.map((e) => ({
            ...e,
            base_kg: 20,
            step_kg: 2.5,
            bands,
          })),
        },
        none,
      );
      expect(filled.open_issues.some((o) => o.scope === "equipment")).toBe(false);
    }
  });
});
