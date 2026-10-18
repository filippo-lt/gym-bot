import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import {
  plannedItemOptions,
  plannedItems,
  planVersions,
  planWeeks,
  sessionOverrides,
} from "../db/schema/index.js";
import type { Q } from "../logging/db.js";
import { type DroppedOverride, repointOverrides } from "./override-repoint.js";
import type { ItemSpec, PlanChange, PlanContent } from "./types.js";

const BATCH = 100;

export class StaleBaseVersionError extends Error {
  constructor(baseVersionId: number) {
    super(`Plan version ${baseVersionId} is no longer the latest version`);
    this.name = "StaleBaseVersionError";
  }
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/** Content of the highest version of a plan. */
export async function loadLatestContent(
  q: Q,
  planId: number,
): Promise<{ versionId: number; version: number; content: PlanContent }> {
  const [latest] = await q
    .select({ id: planVersions.id, version: planVersions.version })
    .from(planVersions)
    .where(eq(planVersions.planId, planId))
    .orderBy(desc(planVersions.version))
    .limit(1);
  if (!latest) throw new Error(`Plan ${planId} has no versions`);

  const weekRows = await q
    .select()
    .from(planWeeks)
    .where(eq(planWeeks.planVersionId, latest.id))
    .orderBy(asc(planWeeks.week));
  const itemRows = await q
    .select()
    .from(plannedItems)
    .where(eq(plannedItems.planVersionId, latest.id))
    .orderBy(
      asc(plannedItems.week),
      asc(plannedItems.weekday),
      asc(plannedItems.itemOrder),
      asc(plannedItems.subItem),
    );

  const optionsByItem = new Map<number, number[]>();
  const ids = itemRows.map((r) => r.id);
  for (const part of chunks(ids)) {
    const opts = await q
      .select()
      .from(plannedItemOptions)
      .where(inArray(plannedItemOptions.plannedItemId, part))
      .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex));
    for (const o of opts) {
      const list = optionsByItem.get(o.plannedItemId) ?? [];
      list.push(o.exerciseId);
      optionsByItem.set(o.plannedItemId, list);
    }
  }

  return {
    versionId: latest.id,
    version: latest.version,
    content: {
      weeks: weekRows.map(({ planVersionId: _v, ...w }) => w),
      items: itemRows.map(({ id, planVersionId: _v, ...rest }) => ({
        ...rest,
        optionExerciseIds: optionsByItem.get(id) ?? [],
      })),
    },
  };
}

/**
 * Insert a full copy of the plan as the next version. Runs in the caller's transaction. One-off
 * swaps dated on/after `effectiveFrom` are moved to the new version's items (or dropped and
 * returned when that day no longer has the exercise).
 */
export async function createVersion(
  tx: Q,
  args: {
    planId: number;
    baseVersionId: number;
    content: PlanContent;
    effectiveFrom: string;
    reason: string;
    change: PlanChange;
  },
): Promise<{ versionId: number; version: number; droppedOverrides: DroppedOverride[] }> {
  const [latest] = await tx
    .select({
      id: planVersions.id,
      version: planVersions.version,
      sourceHash: planVersions.sourceHash,
      resolvedHash: planVersions.resolvedHash,
    })
    .from(planVersions)
    .where(eq(planVersions.planId, args.planId))
    .orderBy(desc(planVersions.version))
    .limit(1)
    .for("update");
  if (!latest || latest.id !== args.baseVersionId) {
    throw new StaleBaseVersionError(args.baseVersionId);
  }
  const version = latest.version + 1;
  const created = await tx
    .insert(planVersions)
    .values({
      planId: args.planId,
      version,
      effectiveFrom: args.effectiveFrom,
      reason: args.reason,
      change: args.change,
      sourceHash: latest.sourceHash,
      resolvedHash: latest.resolvedHash,
    })
    .returning({ id: planVersions.id })
    .then((rows) => rows[0])
    .catch((e: unknown) => {
      if (isUniqueViolation(e)) throw new StaleBaseVersionError(args.baseVersionId);
      throw e;
    });
  if (!created) throw new Error("Failed to insert plan version");
  const versionId = created.id;

  for (const part of chunks(args.content.weeks)) {
    await tx.insert(planWeeks).values(part.map((w) => ({ ...w, planVersionId: versionId })));
  }

  const idByKey = new Map<string, number>();
  for (const part of chunks(args.content.items)) {
    const rows = await tx
      .insert(plannedItems)
      .values(
        part.map(({ optionExerciseIds: _o, ...item }: ItemSpec) => ({
          ...item,
          planVersionId: versionId,
        })),
      )
      .returning({ id: plannedItems.id, itemKey: plannedItems.itemKey });
    for (const r of rows) idByKey.set(r.itemKey, r.id);
  }

  const optionRows = args.content.items.flatMap((item) => {
    const plannedItemId = idByKey.get(item.itemKey);
    if (plannedItemId === undefined) throw new Error(`Missing id for ${item.itemKey}`);
    return item.optionExerciseIds.map((exerciseId, optionIndex) => ({
      plannedItemId,
      exerciseId,
      optionIndex,
    }));
  });
  for (const part of chunks(optionRows)) {
    await tx.insert(plannedItemOptions).values(part);
  }

  const onBase = await tx
    .select({
      id: sessionOverrides.id,
      sessionDate: sessionOverrides.sessionDate,
      plannedItemId: sessionOverrides.plannedItemId,
      replacedExerciseId: sessionOverrides.replacedExerciseId,
      replacementExerciseId: sessionOverrides.replacementExerciseId,
      itemKey: plannedItems.itemKey,
    })
    .from(sessionOverrides)
    .innerJoin(plannedItems, eq(plannedItems.id, sessionOverrides.plannedItemId))
    .where(
      and(
        eq(plannedItems.planVersionId, args.baseVersionId),
        gte(sessionOverrides.sessionDate, args.effectiveFrom),
      ),
    )
    .orderBy(asc(sessionOverrides.id));
  const droppedOverrides = await repointOverrides(tx, onBase, versionId);

  return { versionId, version, droppedOverrides };
}
