import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { OpenIssue, ParsedItem, ResolvedPlan } from "../plan-import/types.js";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface SeedSummary {
  equipment: number;
  exercises: number;
  ladder: number;
  weeks: number;
  items: number;
  options: number;
  action: "inserted" | "unchanged";
}

export class OpenIssuesError extends Error {
  constructor(readonly issues: OpenIssue[]) {
    super(
      `Refusing to seed: ${issues.length} open issue(s):\n${issues
        .map((i) => `  - [${i.scope}] ${i.ref}: ${i.detail}`)
        .join("\n")}`,
    );
    this.name = "OpenIssuesError";
  }
}

export class SeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedConflictError";
  }
}

class DryRunRollback extends Error {
  constructor(readonly summary: SeedSummary) {
    super("dry run rollback");
  }
}

const CHUNK = 200;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

function lookup(map: Map<string, number>, slug: string, what: string, ctx: string): number {
  const id = map.get(slug);
  if (id === undefined) throw new SeedConflictError(`Unknown ${what} slug "${slug}" (${ctx})`);
  return id;
}

export async function seedPlan(
  db: Db,
  resolved: ResolvedPlan,
  opts: { dryRun?: boolean } = {},
): Promise<SeedSummary> {
  const plan = resolved.plan;
  const flagIssues: OpenIssue[] = plan.items.flatMap((i) =>
    i.flags.map((f) => ({
      scope: "item" as const,
      ref: i.key,
      detail: `${f.code}: ${f.detail} (unresolved flag on item)`,
    })),
  );
  const issues = [...resolved.open_issues, ...flagIssues];
  if (issues.length > 0) throw new OpenIssuesError(issues);

  try {
    return await db.transaction(async (tx) => {
      // Reference data: upsert by slug so later-filled equipment numbers re-seed.
      for (const e of plan.equipment) {
        const values = {
          slug: e.slug,
          name: e.name,
          baseKg: e.base_kg,
          stepKg: e.step_kg,
          discreteValues: e.discrete_values,
          bands: e.bands,
        };
        await tx
          .insert(schema.equipment)
          .values(values)
          .onConflictDoUpdate({ target: schema.equipment.slug, set: values });
      }
      const equipmentIds = new Map(
        (
          await tx
            .select({ id: schema.equipment.id, slug: schema.equipment.slug })
            .from(schema.equipment)
        ).map((r) => [r.slug, r.id]),
      );

      for (const x of plan.exercises) {
        const values = {
          slug: x.slug,
          name: x.name,
          aliases: x.aliases,
          muscleGroup: x.muscle_group,
          type: x.type,
          loadBasis: x.load_basis,
          equipmentId: x.equipment_slug
            ? lookup(equipmentIds, x.equipment_slug, "equipment", `exercise ${x.slug}`)
            : null,
          isMainLift: x.is_main_lift,
        };
        await tx
          .insert(schema.exercises)
          .values(values)
          .onConflictDoUpdate({ target: schema.exercises.slug, set: values });
      }
      const exerciseIds = new Map(
        (
          await tx
            .select({ id: schema.exercises.id, slug: schema.exercises.slug })
            .from(schema.exercises)
        ).map((r) => [r.slug, r.id]),
      );

      for (const h of plan.hspu_ladder) {
        const values = {
          slug: h.slug,
          name: h.name,
          stepOrder: h.order,
          defaultSets: h.default_sets,
          defaultRepsMin: h.default_reps_min,
          defaultRepsMax: h.default_reps_max,
          tempo: h.tempo,
        };
        await tx
          .insert(schema.hspuLadder)
          .values(values)
          .onConflictDoUpdate({ target: schema.hspuLadder.slug, set: values });
      }
      const ladderIds = new Map(
        (
          await tx
            .select({ id: schema.hspuLadder.id, slug: schema.hspuLadder.slug })
            .from(schema.hspuLadder)
        ).map((r) => [r.slug, r.id]),
      );

      const optionCount = plan.items.reduce((n, i) => n + i.exercise_options.length, 0);
      const summary: SeedSummary = {
        equipment: plan.equipment.length,
        exercises: plan.exercises.length,
        ladder: plan.hspu_ladder.length,
        weeks: plan.weeks.length,
        items: plan.items.length,
        options: optionCount,
        action: "inserted",
      };

      // Plan + version 1.
      let planRow = (
        await tx.select().from(schema.plans).where(eq(schema.plans.name, plan.name))
      )[0];
      if (!planRow) {
        planRow = (
          await tx
            .insert(schema.plans)
            .values({ name: plan.name, startDate: plan.start_date, weeks: plan.weeks_count })
            .returning()
        )[0];
      }
      if (!planRow) throw new Error("Failed to upsert plan");

      const version = (
        await tx
          .select()
          .from(schema.planVersions)
          .where(
            and(eq(schema.planVersions.planId, planRow.id), eq(schema.planVersions.version, 1)),
          )
      )[0];

      if (version) {
        if (version.sourceHash !== plan.source_hash) {
          throw new SeedConflictError(
            `Plan "${plan.name}" is already seeded from a different source file (hash ${version.sourceHash.slice(0, 12)} vs ${plan.source_hash.slice(0, 12)}). Plan changes after seeding go through plan versions (M7).`,
          );
        }
        if (version.resolvedHash !== resolved.resolved_hash) {
          throw new SeedConflictError(
            `Plan "${plan.name}" content changed after seeding (same source file, different overrides or catalog); plan changes go through plan versions in M7.`,
          );
        }
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.plannedItems)
          .where(eq(schema.plannedItems.planVersionId, version.id));
        if (n !== plan.items.length) {
          throw new SeedConflictError(
            `Plan "${plan.name}" is already seeded but has ${n} items, expected ${plan.items.length}. Database is inconsistent; investigate before re-seeding.`,
          );
        }
        summary.action = "unchanged";
      } else {
        const created = (
          await tx
            .insert(schema.planVersions)
            .values({
              planId: planRow.id,
              version: 1,
              effectiveFrom: plan.start_date,
              reason: "initial import",
              sourceHash: plan.source_hash,
              resolvedHash: resolved.resolved_hash,
            })
            .returning({ id: schema.planVersions.id })
        )[0];
        if (!created) throw new Error("Failed to insert plan version");
        const versionId = created.id;

        await tx.insert(schema.planWeeks).values(
          plan.weeks.map((w) => ({
            planVersionId: versionId,
            week: w.week,
            phase: w.phase,
            isDeload: w.is_deload,
            isTest: w.is_test,
            startDate: w.start_date,
          })),
        );

        const itemRow = (item: ParsedItem) => ({
          planVersionId: versionId,
          itemKey: item.key,
          week: item.week,
          weekday: item.weekday,
          itemOrder: item.order,
          subItem: item.sub_item,
          block: item.block,
          planName: item.plan_name,
          variantLabel: item.variant_label,
          prescriptionRaw: item.prescription_raw,
          extrasRaw: item.extras_raw,
          setsMin: item.sets_min,
          setsMax: item.sets_max,
          repsMin: item.reps_min,
          repsMax: item.reps_max,
          perSide: item.per_side,
          durationSMin: item.duration_s_min,
          durationSMax: item.duration_s_max,
          hiit: item.hiit,
          tempo: item.tempo,
          modifiers: item.modifiers,
          hspuStepId: item.hspu_step
            ? lookup(ladderIds, item.hspu_step, "hspu step", `item ${item.key}`)
            : null,
          rirMin: item.rir_min,
          rirMax: item.rir_max,
          tags: item.tags,
          restRaw: item.rest_raw,
          priority: item.priority,
          note: item.note,
          timeRaw: item.time_raw,
          timeMinMin: item.time_min_min,
          timeMinMax: item.time_min_max,
          fallbackPrescription: item.fallback_prescription,
        });

        // Resolve every slug before writing so unknown slugs fail early and clearly.
        const optionRowsByKey = new Map<string, number[]>();
        for (const item of plan.items) {
          optionRowsByKey.set(
            item.key,
            item.exercise_options.map((s) =>
              lookup(exerciseIds, s, "exercise", `item ${item.key}`),
            ),
          );
        }

        for (const batch of chunks(plan.items)) {
          const inserted = await tx
            .insert(schema.plannedItems)
            .values(batch.map(itemRow))
            .returning({ id: schema.plannedItems.id, key: schema.plannedItems.itemKey });
          const optionRows = inserted.flatMap((r) =>
            (optionRowsByKey.get(r.key) ?? []).map((exerciseId, optionIndex) => ({
              plannedItemId: r.id,
              exerciseId,
              optionIndex,
            })),
          );
          if (optionRows.length > 0) await tx.insert(schema.plannedItemOptions).values(optionRows);
        }
      }

      if (opts.dryRun) throw new DryRunRollback(summary);
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}
