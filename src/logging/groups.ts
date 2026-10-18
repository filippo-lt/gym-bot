import { and, asc, desc, eq, lte, ne } from "drizzle-orm";
import { bodyweightLogs, logEntries, logGroups } from "../db/schema/log.js";
import { exercises, hspuLadder } from "../db/schema/plan.js";
import type { Q } from "./db.js";
import type { GroupSnapshot, LastSessionRef, ResolvedEntry } from "./types.js";
import { maxReps, maxSystemLoad } from "./units.js";

type EntryRow = typeof logEntries.$inferSelect;

export function entryFromRow(e: EntryRow): ResolvedEntry {
  return {
    setIndex: e.setIndex,
    reps: e.reps,
    loadKg: e.loadKg,
    addedKg: e.addedKg,
    assistKg: e.assistKg,
    durationS: e.durationS,
    distanceM: e.distanceM,
    padHeight: e.padHeight,
    rir: e.rir,
    rirPlus: e.rirPlus,
    clean: e.clean,
    note: e.note,
  };
}

export async function groupSnapshot(db: Q, groupId: number): Promise<GroupSnapshot | null> {
  const [row] = await db
    .select({ g: logGroups, ex: exercises, step: hspuLadder })
    .from(logGroups)
    .innerJoin(exercises, eq(exercises.id, logGroups.exerciseId))
    .leftJoin(hspuLadder, eq(hspuLadder.id, logGroups.hspuStepId))
    .where(eq(logGroups.id, groupId));
  if (!row) return null;
  const entries = await db
    .select()
    .from(logEntries)
    .where(eq(logEntries.groupId, groupId))
    .orderBy(asc(logEntries.setIndex));
  return {
    groupId,
    sessionDate: row.g.sessionDate,
    performedAt: row.g.performedAt.toISOString(),
    exercise: {
      id: row.ex.id,
      slug: row.ex.slug,
      name: row.ex.name,
      type: row.ex.type,
      loadBasis: row.ex.loadBasis,
    },
    plannedItemId: row.g.plannedItemId,
    hspuStep: row.step ? { slug: row.step.slug, name: row.step.name } : null,
    bwKg: row.g.bwKg,
    entries: entries.map(entryFromRow),
  };
}

/** The most recent group not created by the history import (edit/undo target). */
export async function lastBotGroup(db: Q): Promise<GroupSnapshot | null> {
  const [row] = await db
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(ne(logGroups.source, "import"))
    .orderBy(desc(logGroups.performedAt), desc(logGroups.id))
    .limit(1);
  return row ? groupSnapshot(db, row.id) : null;
}

export async function latestBwKg(db: Q): Promise<number | null> {
  const [row] = await db
    .select({ kg: bodyweightLogs.kg })
    .from(bodyweightLogs)
    .orderBy(desc(bodyweightLogs.date))
    .limit(1);
  return row?.kg ?? null;
}

/** Most recent session (<= today) with groups of this exercise, any source. */
export async function lastSessionRef(
  db: Q,
  exercise: { id: number; type: GroupSnapshot["exercise"]["type"] },
  today: string,
  excludeGroupId?: number,
): Promise<LastSessionRef | null> {
  const conds = [eq(logGroups.exerciseId, exercise.id), lte(logGroups.sessionDate, today)];
  if (excludeGroupId !== undefined) conds.push(ne(logGroups.id, excludeGroupId));
  const [latest] = await db
    .select({ d: logGroups.sessionDate })
    .from(logGroups)
    .where(and(...conds))
    .orderBy(desc(logGroups.sessionDate))
    .limit(1);
  if (!latest) return null;
  const groups = await db
    .select({ id: logGroups.id, bwKg: logGroups.bwKg })
    .from(logGroups)
    .where(and(...conds, eq(logGroups.sessionDate, latest.d)));
  let maxLoad: number | null = null;
  let best: number | null = null;
  for (const g of groups) {
    const rows = await db.select().from(logEntries).where(eq(logEntries.groupId, g.id));
    const entries = rows.map(entryFromRow);
    const l = maxSystemLoad(entries, exercise, g.bwKg);
    if (l !== null && (maxLoad === null || l > maxLoad)) maxLoad = l;
    const r = maxReps(entries);
    if (r !== null && (best === null || r > best)) best = r;
  }
  return { sessionDate: latest.d, maxSystemLoad: maxLoad, bestReps: best };
}
