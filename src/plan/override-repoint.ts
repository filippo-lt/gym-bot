/**
 * One-off swaps are keyed by planned item id, and a new plan version has new item ids. When a
 * version is created (or removed by Undo), the overrides that sit on the old items are moved to
 * the matching items of the other version, or deleted when the day has no match.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  exercises,
  plannedItemOptions,
  plannedItems,
  planWeeks,
  sessionOverrides,
} from "../db/schema/plan.js";
import type { Q } from "../logging/db.js";
import { addDays } from "../plan-import/build-plan.js";

export interface DroppedOverride {
  sessionDate: string;
  replacedName: string;
  replacementName: string;
}

export interface OverrideOnItem {
  id: number;
  sessionDate: string;
  plannedItemId: number;
  replacedExerciseId: number;
  replacementExerciseId: number;
  itemKey: string;
}

interface Candidate {
  id: number;
  itemKey: string;
  options: number[];
}

const OFFSET: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };

/** The version's items on the given dates, in day order, with their option exercise ids. */
async function itemsOnDates(
  tx: Q,
  versionId: number,
  dates: Set<string>,
): Promise<Map<string, Candidate[]>> {
  const rows = await tx
    .select({
      id: plannedItems.id,
      itemKey: plannedItems.itemKey,
      weekday: plannedItems.weekday,
      startDate: planWeeks.startDate,
    })
    .from(plannedItems)
    .innerJoin(
      planWeeks,
      and(
        eq(planWeeks.planVersionId, plannedItems.planVersionId),
        eq(planWeeks.week, plannedItems.week),
      ),
    )
    .where(eq(plannedItems.planVersionId, versionId))
    .orderBy(asc(plannedItems.itemOrder), asc(plannedItems.subItem));
  const out = new Map<string, Candidate[]>();
  const byId = new Map<number, Candidate>();
  for (const r of rows) {
    const date = addDays(r.startDate, OFFSET[r.weekday] ?? 0);
    if (!dates.has(date)) continue;
    const c: Candidate = { id: r.id, itemKey: r.itemKey, options: [] };
    byId.set(r.id, c);
    const list = out.get(date) ?? [];
    list.push(c);
    out.set(date, list);
  }
  const ids = [...byId.keys()];
  if (ids.length > 0) {
    const opts = await tx
      .select()
      .from(plannedItemOptions)
      .where(inArray(plannedItemOptions.plannedItemId, ids))
      .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex));
    for (const o of opts) byId.get(o.plannedItemId)?.options.push(o.exerciseId);
  }
  return out;
}

/**
 * Moves each override to the item of `targetVersionId` on the same date whose options contain the
 * replaced exercise (the same item key wins). No match: the override is deleted and returned.
 */
export async function repointOverrides(
  tx: Q,
  overrides: OverrideOnItem[],
  targetVersionId: number,
): Promise<DroppedOverride[]> {
  if (overrides.length === 0) return [];
  const byDate = await itemsOnDates(
    tx,
    targetVersionId,
    new Set(overrides.map((o) => o.sessionDate)),
  );
  const taken = new Set<string>();
  const candidateIds = [...byDate.values()].flatMap((l) => l.map((c) => c.id));
  const existing =
    candidateIds.length > 0
      ? await tx
          .select()
          .from(sessionOverrides)
          .where(inArray(sessionOverrides.plannedItemId, candidateIds))
      : [];
  for (const e of existing)
    taken.add(`${e.sessionDate}:${e.plannedItemId}:${e.replacedExerciseId}`);

  const dropped: OverrideOnItem[] = [];
  for (const o of overrides) {
    const hits = (byDate.get(o.sessionDate) ?? []).filter((c) =>
      c.options.includes(o.replacedExerciseId),
    );
    const pick = hits.find((c) => c.itemKey === o.itemKey) ?? hits[0];
    const key = pick ? `${o.sessionDate}:${pick.id}:${o.replacedExerciseId}` : null;
    if (!pick || key === null || taken.has(key)) {
      await tx.delete(sessionOverrides).where(eq(sessionOverrides.id, o.id));
      dropped.push(o);
      continue;
    }
    taken.add(key);
    await tx
      .update(sessionOverrides)
      .set({ plannedItemId: pick.id })
      .where(eq(sessionOverrides.id, o.id));
  }
  return namesOf(tx, dropped);
}

async function namesOf(tx: Q, dropped: OverrideOnItem[]): Promise<DroppedOverride[]> {
  if (dropped.length === 0) return [];
  const ids = [...new Set(dropped.flatMap((d) => [d.replacedExerciseId, d.replacementExerciseId]))];
  const rows = await tx
    .select({ id: exercises.id, name: exercises.name })
    .from(exercises)
    .where(inArray(exercises.id, ids));
  const name = new Map(rows.map((r) => [r.id, r.name]));
  return dropped.map((d) => ({
    sessionDate: d.sessionDate,
    replacedName: name.get(d.replacedExerciseId) ?? "?",
    replacementName: name.get(d.replacementExerciseId) ?? "?",
  }));
}
