import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Equipment, HspuStep, PlanOverrides } from "./types.js";

const EquipmentSchema = z.array(
  z.object({
    slug: z.string(),
    name: z.string(),
    base_kg: z.number().nullable(),
    step_kg: z.number().nullable(),
    discrete_values: z.array(z.number()).nullable(),
    bands: z.record(z.string(), z.number()).nullable(),
  }),
);

const HspuSchema = z.array(
  z.object({
    slug: z.string(),
    name: z.string(),
    order: z.number().int(),
    default_sets: z.number().nullable(),
    default_reps_min: z.number().nullable(),
    default_reps_max: z.number().nullable(),
    tempo: z.string().nullable(),
  }),
);

const OverridesSchema = z.object({
  source_hash: z.string(),
  // Item and exercise entries are validated strictly in applyOverrides so mistakes become open issues.
  items: z.record(z.string(), z.unknown()),
  exercises: z.record(z.string(), z.unknown()).optional(),
});

export function readPlanFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function loadEquipment(path: string): Equipment[] {
  return EquipmentSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadHspuLadder(path: string): HspuStep[] {
  return HspuSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadOverrides(path: string): PlanOverrides {
  return OverridesSchema.parse(JSON.parse(readFileSync(path, "utf8"))) as unknown as PlanOverrides;
}
