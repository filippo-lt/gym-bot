import { and, asc, desc, eq, lt, lte, ne, or } from "drizzle-orm";
import { bodyweightLogs, logEntries, logGroups } from "../db/schema/log.js";
import { equipment, exercises, hspuLadder } from "../db/schema/plan.js";
import { suggestions } from "../db/schema/progression.js";
import type { Q } from "./db.js";
import type { GroupSnapshot, LastSessionRef, ResolvedEntry } from "./types.js";
import { bandAssist, maxReps, maxSystemLoad } from "./units.js";

type EntryRow = typeof logEntries.$inferSelect;

export function entryFromRow(e: EntryRow, bands?: Record<string, number>): ResolvedEntry {
  return {
    setIndex: e.setIndex,
    reps: e.reps,
    loadKg: e.loadKg,
    addedKg: e.addedKg,
    assistKg: bandAssist(e.band, e.assistKg, bands),
    durationS: e.durationS,
    distanceM: e.distanceM,
    padHeight: e.padHeight,
    rir: e.rir,
    rirPlus: e.rirPlus,
    clean: e.clean,
    note: e.note,
    band: e.band,
  };
}

/** The stored suggestion row for one item/option of a session date (id + system load), if any. */
export async function storedSuggestion(
  db: Q,
  date: string,
  plannedItemId: number,
  subItem: number,
  exerciseId: number,
): Promise<{ id: number; systemLoad: number | null } | null> {
  const [row] = await db
    .select({ id: suggestions.id, systemLoad: suggestions.systemLoad })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.sessionDate, date),
        eq(suggestions.plannedItemId, plannedItemId),
        eq(suggestions.subItem, subItem),
        eq(suggestions.exerciseId, exerciseId),
      ),
    );
  return row ?? null;
}

/** System load of the suggestion a log group was logged against (null = none or no load). */
export async function groupSuggestedLoad(db: Q, groupId: number): Promise<number | null> {
  const [row] = await db
    .select({ systemLoad: suggestions.systemLoad })
    .from(logGroups)
    .innerJoin(suggestions, eq(suggestions.id, logGroups.suggestionId))
    .where(eq(logGroups.id, groupId));
  return row?.systemLoad ?? null;
}

export async function groupSnapshot(db: Q, groupId: number): Promise<GroupSnapshot | null> {
  const [row] = await db
    .select({ g: logGroups, ex: exercises, step: hspuLadder, eq: equipment })
    .from(logGroups)
    .innerJoin(exercises, eq(exercises.id, logGroups.exerciseId))
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
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
      equipment: row.eq
        ? {
            slug: row.eq.slug,
            baseKg: row.eq.baseKg,
            stepKg: row.eq.stepKg,
            discreteValues: row.eq.discreteValues,
            bands: row.eq.bands ?? {},
          }
        : null,
    },
    plannedItemId: row.g.plannedItemId,
    hspuStep: row.step ? { slug: row.step.slug, name: row.step.name } : null,
    bwKg: row.g.bwKg,
    entries: entries.map((e) => entryFromRow(e, row.eq?.bands ?? {})),
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

/**
 * True when the colour was already used in a group saved before this one (the kg question is asked once per colour).
 * Groups saved by the same message share a timestamp: the lowest id counts as first and asks.
 */
export async function bandSeenElsewhere(db: Q, colour: string, groupId: number): Promise<boolean> {
  const [g] = await db
    .select({ at: logGroups.performedAt })
    .from(logGroups)
    .where(eq(logGroups.id, groupId));
  if (!g) return false;
  const [row] = await db
    .select({ id: logEntries.id })
    .from(logEntries)
    .innerJoin(logGroups, eq(logGroups.id, logEntries.groupId))
    .where(
      and(
        eq(logEntries.band, colour),
        ne(logEntries.groupId, groupId),
        or(
          lt(logGroups.performedAt, g.at),
          and(eq(logGroups.performedAt, g.at), lt(logGroups.id, groupId)),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
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
  const [eqRow] = await db
    .select({ bands: equipment.bands })
    .from(exercises)
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
    .where(eq(exercises.id, exercise.id));
  const bands = eqRow?.bands ?? {};
  for (const g of groups) {
    const rows = await db.select().from(logEntries).where(eq(logEntries.groupId, g.id));
    const entries = rows.map((e) => entryFromRow(e, bands));
    const l = maxSystemLoad(entries, exercise, g.bwKg);
    if (l !== null && (maxLoad === null || l > maxLoad)) maxLoad = l;
    const r = maxReps(entries);
    if (r !== null && (best === null || r > best)) best = r;
  }
  return { sessionDate: latest.d, maxSystemLoad: maxLoad, bestReps: best };
}
