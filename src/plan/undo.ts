/** Undo of a plan change (M7): removes the version, overrides and created exercise while unused. */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { pendingActions, writeLedger } from "../db/schema/agent.js";
import { logGroups, sessionItems } from "../db/schema/log.js";
import {
  exercises,
  plannedItemOptions,
  plannedItems,
  planVersions,
  planWeeks,
  sessionOverrides,
} from "../db/schema/plan.js";
import { proposals, readinessLogs, suggestions } from "../db/schema/progression.js";
import type { Q } from "../logging/db.js";
import { type DroppedOverride, repointOverrides } from "./override-repoint.js";
import type { PlanChangeResult } from "./swap-execute.js";

const TOO_LATE = "Too late to undo: it's already in use. Swap back instead.";
/** `dropped`: one-off swaps that could not move back to the old version's items. */
type UndoOutcome = { ok: true; dropped: DroppedOverride[] } | { ok: false; reply: string };

async function versionInUse(tx: Q, versionId: number): Promise<boolean> {
  const [v] = await tx
    .select({ planId: planVersions.planId })
    .from(planVersions)
    .where(eq(planVersions.id, versionId));
  if (!v) return false;
  const [top] = await tx
    .select({ id: planVersions.id })
    .from(planVersions)
    .where(eq(planVersions.planId, v.planId))
    .orderBy(desc(planVersions.version))
    .limit(1);
  if (top?.id !== versionId) return true;

  const items = await tx
    .select({ id: plannedItems.id })
    .from(plannedItems)
    .where(eq(plannedItems.planVersionId, versionId));
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return false;

  const [si] = await tx
    .select({ id: sessionItems.id })
    .from(sessionItems)
    .where(inArray(sessionItems.plannedItemId, ids))
    .limit(1);
  if (si) return true;
  const [lg] = await tx
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(inArray(logGroups.plannedItemId, ids))
    .limit(1);
  if (lg) return true;
  const [sg] = await tx
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(inArray(suggestions.plannedItemId, ids))
    .limit(1);
  if (sg) return true;

  // An open card may still point at one of these items (text search on the jsonb).
  const open = await tx
    .select({ actions: sql<string>`${pendingActions.actions}::text` })
    .from(pendingActions)
    .where(eq(pendingActions.status, "open"));
  const idSet = new Set(ids);
  for (const p of open) {
    for (const m of p.actions.matchAll(/\d+/g)) {
      if (idSet.has(Number(m[0]))) return true;
    }
  }
  return false;
}

export async function undoPlanChange(
  tx: Q,
  sourceKey: string,
  index: number,
): Promise<UndoOutcome> {
  const [row] = await tx
    .select({ result: writeLedger.result })
    .from(writeLedger)
    .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, index)))
    .for("update");
  const r = row?.result as PlanChangeResult | undefined;
  if (r?.kind !== "plan_change") return { ok: false, reply: "Nothing to undo." };
  if (r.undone) return { ok: false, reply: "Already undone." };

  if (r.versionId !== null && (await versionInUse(tx, r.versionId))) {
    return { ok: false, reply: TOO_LATE };
  }

  const overrides =
    r.overrideIds.length > 0
      ? await tx.select().from(sessionOverrides).where(inArray(sessionOverrides.id, r.overrideIds))
      : [];
  for (const o of overrides) {
    const [g] = await tx
      .select({ id: logGroups.id })
      .from(logGroups)
      .where(
        and(
          eq(logGroups.sessionDate, o.sessionDate),
          eq(logGroups.exerciseId, o.replacementExerciseId),
        ),
      )
      .limit(1);
    if (g) return { ok: false, reply: TOO_LATE };
  }

  if (r.overrideIds.length > 0) {
    await tx.delete(sessionOverrides).where(inArray(sessionOverrides.id, r.overrideIds));
  }
  let dropped: DroppedOverride[] = [];
  if (r.versionId !== null) {
    const items = await tx
      .select({ id: plannedItems.id })
      .from(plannedItems)
      .where(eq(plannedItems.planVersionId, r.versionId));
    const ids = items.map((i) => i.id);
    // One-off swaps made later on this version's items move back to the previous version.
    const [mine] = await tx
      .select({ planId: planVersions.planId, version: planVersions.version })
      .from(planVersions)
      .where(eq(planVersions.id, r.versionId));
    const [base] = mine
      ? await tx
          .select({ id: planVersions.id })
          .from(planVersions)
          .where(and(eq(planVersions.planId, mine.planId), lt(planVersions.version, mine.version)))
          .orderBy(desc(planVersions.version))
          .limit(1)
      : [];
    const foreign =
      ids.length > 0
        ? await tx
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
            .where(inArray(sessionOverrides.plannedItemId, ids))
        : [];
    if (foreign.length > 0) {
      if (!base) return { ok: false, reply: TOO_LATE };
      dropped = await repointOverrides(tx, foreign, base.id);
    }
    if (ids.length > 0) {
      await tx.delete(plannedItemOptions).where(inArray(plannedItemOptions.plannedItemId, ids));
    }
    await tx.delete(plannedItems).where(eq(plannedItems.planVersionId, r.versionId));
    await tx.delete(planWeeks).where(eq(planWeeks.planVersionId, r.versionId));
    await tx.delete(planVersions).where(eq(planVersions.id, r.versionId));
  }
  if (r.createdExerciseId !== null) {
    const id = r.createdExerciseId;
    const [a] = await tx
      .select({ x: logGroups.id })
      .from(logGroups)
      .where(eq(logGroups.exerciseId, id))
      .limit(1);
    const [b] = await tx
      .select({ x: plannedItemOptions.plannedItemId })
      .from(plannedItemOptions)
      .where(eq(plannedItemOptions.exerciseId, id))
      .limit(1);
    const [c] = await tx
      .select({ x: sessionOverrides.id })
      .from(sessionOverrides)
      .where(
        or(
          eq(sessionOverrides.replacedExerciseId, id),
          eq(sessionOverrides.replacementExerciseId, id),
        ),
      )
      .limit(1);
    const [d] = await tx
      .select({ x: suggestions.id })
      .from(suggestions)
      .where(eq(suggestions.exerciseId, id))
      .limit(1);
    const [e] = await tx
      .select({ x: sessionItems.id })
      .from(sessionItems)
      .where(eq(sessionItems.chosenExerciseId, id))
      .limit(1);
    const [f] = await tx
      .select({ x: readinessLogs.id })
      .from(readinessLogs)
      .where(eq(readinessLogs.exerciseId, id))
      .limit(1);
    if (!a && !b && !c && !d && !e && !f) await tx.delete(exercises).where(eq(exercises.id, id));
  }

  await tx
    .update(writeLedger)
    .set({ result: { ...r, undone: true } })
    .where(and(eq(writeLedger.sourceKey, sourceKey), eq(writeLedger.actionIndex, index)));

  if (sourceKey.startsWith("r:")) {
    const proposalId = Number(sourceKey.slice(2));
    if (Number.isInteger(proposalId)) {
      await tx
        .update(proposals)
        .set({ status: "declined", decidedAt: new Date() })
        .where(eq(proposals.id, proposalId));
    }
  }
  return { ok: true, dropped };
}
