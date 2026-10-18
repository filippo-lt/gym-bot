import { asc, eq } from "drizzle-orm";
import { equipment, exercises, hspuLadder } from "../db/schema/plan.js";
import type { Q } from "./db.js";
import type { Candidate, ResolvedExercise } from "./types.js";

export interface CatalogExercise extends ResolvedExercise {
  aliases: string[];
}

export interface LadderStep extends Candidate {
  id: number;
  order: number;
}

export async function loadCatalog(db: Q): Promise<CatalogExercise[]> {
  const rows = await db
    .select({ e: exercises, q: equipment })
    .from(exercises)
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
    .orderBy(asc(exercises.id));
  return rows.map(({ e, q }) => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    aliases: e.aliases,
    type: e.type,
    loadBasis: e.loadBasis,
    isMainLift: e.isMainLift,
    needsClean: e.type === "bodyweight_plus" || e.type === "skill_ladder",
    equipment: q
      ? {
          slug: q.slug,
          baseKg: q.baseKg,
          stepKg: q.stepKg,
          discreteValues: q.discreteValues,
        }
      : null,
  }));
}

export async function loadLadder(db: Q): Promise<LadderStep[]> {
  const rows = await db.select().from(hspuLadder).orderBy(asc(hspuLadder.stepOrder));
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, order: r.stepOrder }));
}
