/** Read-only facts for "alternative to X?" questions. Claude proposes; code supplies facts. */
import { and, arrayOverlaps, eq, inArray } from "drizzle-orm";
import { WEEKDAY_ORDER } from "../bot/session.js";
import { equipment, exercises, plannedItemOptions, plannedItems } from "../db/schema/plan.js";
import { trainingDate } from "../domain/calendar.js";
import type { Db } from "../logging/db.js";
import { listMemory } from "../logging/memory.js";
import { versionOn } from "../plan/effective.js";
import { addDays } from "../plan-import/build-plan.js";
import type { Priority, Weekday } from "../plan-import/types.js";

export interface AlternativeFacts {
  exercise: {
    slug: string;
    name: string;
    type: string;
    loadBasis: string | null;
    muscleGroup: string;
    equipment: string | null;
  };
  /** Movement tags of the planned items that use this exercise. */
  movementTags: string[];
  plannedIn: { weekday: Weekday; block: string; planName: string; priority: Priority }[];
  /** Other catalog exercises that share a movement tag (via planned items). */
  samePatternInCatalog: { slug: string; name: string; equipment: string | null }[];
  limitations: string[];
  preferences: string[];
}

/** Tags that describe the movement, not the role or logistics of an item. */
const NON_MOVEMENT_TAGS = new Set([
  "warmup",
  "mobility",
  "class",
  "recovery",
  "accessory",
  "prehab",
  "hiit",
  "skill_strength",
  "skill_practice",
]);
const MAX_SAME_PATTERN = 12;

/**
 * "Where it is planned" comes from the version effective on `today`, for dates from today on.
 * One-off swaps are not looked at: this is a cheap overview, not the day's session.
 */
export async function getAlternativeFacts(
  db: Db,
  exercise: { id: number },
  today: string = trainingDate(new Date()),
): Promise<AlternativeFacts | null> {
  const [ex] = await db
    .select({ e: exercises, equipmentName: equipment.name })
    .from(exercises)
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
    .where(eq(exercises.id, exercise.id));
  if (!ex) return null;

  const version = await versionOn(db, today);
  const optionRows = await db
    .select({ itemId: plannedItemOptions.plannedItemId })
    .from(plannedItemOptions)
    .where(eq(plannedItemOptions.exerciseId, exercise.id));
  const itemIds = [...new Set(optionRows.map((r) => r.itemId))];
  // Movement tags come from every version, so a swapped-away exercise still has a pattern.
  const items = itemIds.length
    ? await db.select().from(plannedItems).where(inArray(plannedItems.id, itemIds))
    : [];
  // Plan week N starts on startDate + 7 * (N - 1). Planned = version effective today, from today on.
  const upcoming = items.filter(
    (i) =>
      version !== null &&
      i.planVersionId === version.versionId &&
      addDays(version.startDate, 7 * (i.week - 1) + WEEKDAY_ORDER.indexOf(i.weekday)) >= today,
  );

  // How many options each of those items has: an OR item mixes the tags of its options.
  const allOptions = itemIds.length
    ? await db
        .select({ itemId: plannedItemOptions.plannedItemId })
        .from(plannedItemOptions)
        .where(inArray(plannedItemOptions.plannedItemId, itemIds))
    : [];
  const optionCount = new Map<number, number>();
  for (const o of allOptions) optionCount.set(o.itemId, (optionCount.get(o.itemId) ?? 0) + 1);

  const movement = (tags: string[]) => tags.filter((t) => !NON_MOVEMENT_TAGS.has(t));
  const singles = items.filter((i) => optionCount.get(i.id) === 1);
  const tagSource = singles.length > 0 ? singles : items;
  const movementTags = [...new Set(tagSource.flatMap((i) => movement(i.tags)))];

  const seen = new Set<string>();
  const plannedIn: AlternativeFacts["plannedIn"] = [];
  for (const i of [...upcoming].sort((a, b) => a.week - b.week || a.itemOrder - b.itemOrder)) {
    const key = `${i.weekday}|${i.block}|${i.planName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plannedIn.push({
      weekday: i.weekday,
      block: i.block,
      planName: i.planName,
      priority: i.priority as Priority,
    });
  }

  let samePatternInCatalog: AlternativeFacts["samePatternInCatalog"] = [];
  if (movementTags.length > 0 && version) {
    // Single-option items of the version effective today: an OR item would pull in exercises of another pattern.
    const rows = await db
      .select({
        itemId: plannedItems.id,
        tags: plannedItems.tags,
        id: exercises.id,
        slug: exercises.slug,
        name: exercises.name,
        equipmentName: equipment.name,
      })
      .from(plannedItems)
      .innerJoin(plannedItemOptions, eq(plannedItemOptions.plannedItemId, plannedItems.id))
      .innerJoin(exercises, eq(exercises.id, plannedItemOptions.exerciseId))
      .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
      .where(
        and(
          arrayOverlaps(plannedItems.tags, movementTags),
          eq(plannedItems.planVersionId, version.versionId),
        ),
      );
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.itemId, (counts.get(r.itemId) ?? 0) + 1);
    const found = new Map<string, { slug: string; name: string; equipment: string | null }>();
    for (const r of rows) {
      if (r.id === exercise.id || counts.get(r.itemId) !== 1) continue;
      if (!r.tags.some((t) => movementTags.includes(t))) continue;
      if (!found.has(r.slug)) {
        found.set(r.slug, { slug: r.slug, name: r.name, equipment: r.equipmentName });
      }
    }
    samePatternInCatalog = [...found.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SAME_PATTERN);
  }

  const memory = await listMemory(db);
  return {
    exercise: {
      slug: ex.e.slug,
      name: ex.e.name,
      type: ex.e.type,
      loadBasis: ex.e.loadBasis,
      muscleGroup: ex.e.muscleGroup,
      equipment: ex.equipmentName,
    },
    movementTags,
    plannedIn,
    samePatternInCatalog,
    limitations: memory.filter((m) => m.kind === "limitation").map((m) => m.content),
    preferences: memory.filter((m) => m.kind === "preference").map((m) => m.content),
  };
}
