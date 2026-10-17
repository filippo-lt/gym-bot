import { createHash } from "node:crypto";
import { z } from "zod";
import { CATALOG_BY_SLUG, OR_PLAN_NAMES } from "./exercise-catalog.js";
import type {
  CatalogExercise,
  ExerciseOverride,
  ItemOverride,
  OpenIssue,
  ParsedItem,
  ParsedPlan,
  PlanOverrides,
  ResolvedPlan,
} from "./types.js";

const LOAD_TYPES = new Set(["weighted", "bodyweight_plus"]);
const NEEDS_BASE_KG = ["barbell", "hack_squat"];
const NEEDS_BANDS = ["pullup"];

const int = z.number().int();
const intOrNull = int.nullable();
const strOrNull = z.string().nullable();
const MODIFIERS = [
  "easy",
  "light",
  "optional",
  "heavy_clean",
  "slightly_heavier",
  "test",
  "deload",
  "max_attempts",
  "stop_before_form_breaks",
] as const;
const TAGS = [
  "skill_strength",
  "skill_practice",
  "vertical_pull",
  "vertical_press",
  "horizontal_press",
  "row",
  "hinge",
  "squat",
  "unilateral_leg",
  "core",
  "accessory",
  "prehab",
  "hiit",
  "mobility",
  "warmup",
  "recovery",
  "class",
] as const;
const PRIORITIES = ["PRIMARY", "High", "Important", "Medium", "Low", "Prep", "Recovery"] as const;
const FLAG_CODES = [
  "unparsed_text",
  "missing_sets",
  "missing_reps",
  "max_reps",
  "optional_extra",
  "hspu_step_from_state",
  "unknown_exercise",
  "or_option_unclear",
] as const;
const setsReps = { sets: int, reps_min: int, reps_max: int };

/** Strict: unknown fields and identity fields (key, week, weekday, order, sub_item, flags) are rejected. */
export const ItemOverrideSchema = z.strictObject({
  resolve: z.array(z.enum(FLAG_CODES)).default([]),
  comment: z.string().optional(),
  block: z.string().optional(),
  plan_name: z.string().optional(),
  exercise_options: z.array(z.string()).optional(),
  variant_label: strOrNull.optional(),
  prescription_raw: z.string().optional(),
  extras_raw: strOrNull.optional(),
  sets_min: intOrNull.optional(),
  sets_max: intOrNull.optional(),
  reps_min: intOrNull.optional(),
  reps_max: intOrNull.optional(),
  per_side: z.boolean().optional(),
  duration_s_min: intOrNull.optional(),
  duration_s_max: intOrNull.optional(),
  hiit: z.strictObject({ rounds: int, work_s: int, rest_s: int }).nullable().optional(),
  tempo: strOrNull.optional(),
  modifiers: z.array(z.enum(MODIFIERS)).optional(),
  hspu_step: strOrNull.optional(),
  rir_min: intOrNull.optional(),
  rir_max: intOrNull.optional(),
  tags: z.array(z.enum(TAGS)).optional(),
  rest_raw: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  note: strOrNull.optional(),
  time_raw: z.string().optional(),
  time_min_min: intOrNull.optional(),
  time_min_max: intOrNull.optional(),
  fallback_prescription: z
    .strictObject({
      if_bw_max_gte: int,
      // biome-ignore lint/suspicious/noThenProperty: field name is fixed by the FallbackPrescription contract
      then: z.strictObject({ ...setsReps, mode: z.literal("bodyweight") }),
      else: z.strictObject({ ...setsReps, mode: z.literal("assisted") }),
    })
    .nullable()
    .optional(),
});

export const ExerciseOverrideSchema = z.strictObject({
  acknowledge: z.literal(true),
  comment: z.string().optional(),
  type: z
    .enum([
      "weighted",
      "bodyweight_plus",
      "bodyweight_reps",
      "skill_ladder",
      "timed",
      "distance",
      "skill_practice",
      "hiit",
      "mobility",
      "warmup",
      "class",
      "recovery",
    ])
    .optional(),
  load_basis: z
    .enum(["barbell_total", "per_hand", "stack", "bodyweight_plus"])
    .nullable()
    .optional(),
  equipment_slug: strOrNull.optional(),
  muscle_group: z.string().optional(),
});

function zodMessages(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(entry)"}: ${i.message}`).join("; ");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

/** Equipment is deliberately left out: its values change after seeding without changing the plan. */
export function computeResolvedHash(plan: ParsedPlan): string {
  const bySlug = (a: { slug: string }, b: { slug: string }) => (a.slug < b.slug ? -1 : 1);
  const canonical = sortKeys({
    weeks: [...plan.weeks].sort((a, b) => a.week - b.week),
    items: [...plan.items].sort((a, b) => (a.key < b.key ? -1 : 1)),
    exercises: [...plan.exercises].sort(bySlug),
    hspu_ladder: [...plan.hspu_ladder].sort((a, b) => a.order - b.order),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function applyOverrides(plan: ParsedPlan, overrides: PlanOverrides): ResolvedPlan {
  const issues: OpenIssue[] = [];
  const keys = new Set(plan.items.map((i) => i.key));
  const ladderSlugs = new Set(plan.hspu_ladder.map((s) => s.slug));

  if (overrides.source_hash !== plan.source_hash) {
    issues.push({
      scope: "plan",
      ref: "source_hash",
      detail:
        "seed/plan-overrides.json was written for a different plan file. If the plan file changed, review the plan again first, then update source_hash.",
    });
  }

  const exercises: CatalogExercise[] = plan.exercises.map((e) => ({ ...e }));
  const items: ParsedItem[] = plan.items.map((item) => {
    const raw = overrides.items[item.key];
    if (raw === undefined) return item;
    const parsed = ItemOverrideSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        scope: "item",
        ref: item.key,
        detail: `Invalid override, ignored: ${zodMessages(parsed.error)}`,
      });
      return item;
    }
    const { resolve, comment: _comment, ...fields } = parsed.data as ItemOverride;
    const merged: ParsedItem = { ...item };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
    }
    merged.flags = item.flags.filter((f) => !resolve.includes(f.code));

    const problems: string[] = [];
    if (merged.exercise_options.length === 0) problems.push("exercise_options is empty");
    if (merged.exercise_options.length >= 2 && !OR_PLAN_NAMES.has(merged.plan_name)) {
      problems.push(
        `"${merged.plan_name}" is not an OR item, so it needs exactly 1 exercise option`,
      );
    }
    for (const slug of merged.exercise_options) {
      const c = CATALOG_BY_SLUG.get(slug);
      if (!c) problems.push(`unknown exercise slug "${slug}"`);
      else if (!exercises.some((e) => e.slug === slug)) exercises.push({ ...c });
    }
    if (merged.hspu_step !== null && !ladderSlugs.has(merged.hspu_step)) {
      problems.push(`hspu_step "${merged.hspu_step}" is not a ladder step`);
    }
    for (const p of problems) {
      issues.push({ scope: "item", ref: item.key, detail: `Invalid override: ${p}.` });
    }
    return merged;
  });

  for (const key of Object.keys(overrides.items)) {
    if (!keys.has(key)) {
      issues.push({
        scope: "item",
        ref: key,
        detail: "This override key matches no plan item. Fix the key or remove it.",
      });
    }
  }

  // Exercise overrides: acknowledge clears the review note; given fields change the entry.
  for (const [slug, raw] of Object.entries(overrides.exercises ?? {})) {
    const target = exercises.find((e) => e.slug === slug);
    if (!target) {
      issues.push({
        scope: "exercise",
        ref: slug,
        detail: "This exercise override matches no exercise used in the plan.",
      });
      continue;
    }
    const parsed = ExerciseOverrideSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        scope: "exercise",
        ref: slug,
        detail: `Invalid exercise override, ignored: ${zodMessages(parsed.error)}`,
      });
      continue;
    }
    const { acknowledge: _a, comment: _c, ...fields } = parsed.data as ExerciseOverride;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (target as unknown as Record<string, unknown>)[k] = v;
    }
    target.review_note = null;
  }

  for (const item of items) {
    for (const f of item.flags) {
      issues.push({
        scope: "item",
        ref: item.key,
        detail: `${f.code}: ${f.detail} (${item.plan_name}, "${item.prescription_raw}")`,
      });
    }
  }

  const neededEquipment = new Set(
    exercises
      .filter((e) => LOAD_TYPES.has(e.type) && e.equipment_slug)
      .map((e) => e.equipment_slug as string),
  );
  for (const eq of plan.equipment) {
    if (neededEquipment.has(eq.slug) && eq.step_kg === null && eq.discrete_values === null) {
      issues.push({
        scope: "equipment",
        ref: eq.slug,
        detail: `${eq.name}: step_kg and discrete_values are both empty.`,
      });
    }
    if (NEEDS_BASE_KG.includes(eq.slug) && eq.base_kg === null) {
      issues.push({
        scope: "equipment",
        ref: eq.slug,
        detail: `${eq.name}: base_kg is empty (weight of the empty bar or unloaded sled).`,
      });
    }
    if (NEEDS_BANDS.includes(eq.slug) && eq.bands === null) {
      issues.push({
        scope: "equipment",
        ref: eq.slug,
        detail: `${eq.name}: bands is empty (band colour to kg of assistance).`,
      });
    }
  }
  for (const slug of neededEquipment) {
    if (!plan.equipment.some((e) => e.slug === slug)) {
      issues.push({
        scope: "equipment",
        ref: slug,
        detail: "Equipment is used by an exercise but missing from seed/equipment.json.",
      });
    }
  }

  for (const step of plan.hspu_ladder) {
    const missing = (
      [
        ["default_sets", step.default_sets],
        ["default_reps_min", step.default_reps_min],
        ["default_reps_max", step.default_reps_max],
      ] as const
    )
      .filter(([, v]) => v === null)
      .map(([n]) => n);
    if (missing.length > 0) {
      issues.push({
        scope: "hspu_ladder",
        ref: step.slug,
        detail: `${step.name}: empty ${missing.join(", ")}.`,
      });
    }
  }

  for (const e of exercises) {
    if (e.review_note) issues.push({ scope: "exercise", ref: e.slug, detail: e.review_note });
  }

  const resolvedPlan: ParsedPlan = { ...plan, exercises, items };
  return {
    plan: resolvedPlan,
    resolved_hash: computeResolvedHash(resolvedPlan),
    open_issues: issues,
  };
}
