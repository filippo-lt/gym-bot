/**
 * Saving a swap (M7), run at ✅ time inside the executor's transaction. Everything that depends
 * on the clock or on the latest plan version is decided here, not when the card was built.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { logGroups } from "../db/schema/log.js";
import { equipment, exercises, plans, sessionOverrides } from "../db/schema/plan.js";
import type { Q } from "../logging/db.js";
import type { ResolvedSwap } from "../logging/types.js";
import { addDays } from "../plan-import/build-plan.js";
import { computeRir } from "../plan-import/rir.js";
import type { Modifier } from "../plan-import/types.js";
import { applySwap } from "./swap-transform.js";
import { createVersion, loadLatestContent, StaleBaseVersionError } from "./versions.js";

export interface PlanChangeResult {
  kind: "plan_change";
  overrideIds: number[];
  versionId: number | null;
  createdExerciseId: number | null;
  /** Set by Undo; a second Undo then answers "Already undone." */
  undone?: boolean;
}

export type SwapOutcome = PlanChangeResult | { refused: string };

const WEEKDAY_NAMES: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
};

function dateWords(date: string, today: string): string {
  if (date === today) return "today";
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay();
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `on ${names[wd]} ${date.slice(8)}`;
}

async function ensureExercise(
  tx: Q,
  r: ResolvedSwap,
  alias: string,
): Promise<{ id: number; created: boolean }> {
  if (!r.to.isNew) {
    if (r.to.id === null) throw new Error("Swap target has no id.");
    return { id: r.to.id, created: false };
  }
  const spec = r.to.newSpec;
  if (!spec) throw new Error("New exercise without a spec.");
  const [existing] = await tx
    .select({ id: exercises.id })
    .from(exercises)
    .where(eq(exercises.slug, r.to.slug));
  if (existing) return { id: existing.id, created: false };
  let equipmentId: number | null = null;
  if (spec.equipmentSlug) {
    const [eq1] = await tx
      .select({ id: equipment.id })
      .from(equipment)
      .where(eq(equipment.slug, spec.equipmentSlug));
    equipmentId = eq1?.id ?? null;
  }
  const [row] = await tx
    .insert(exercises)
    .values({
      slug: r.to.slug,
      name: r.to.name,
      aliases: alias ? [alias] : [],
      muscleGroup: spec.muscleGroup,
      type: spec.type,
      loadBasis: spec.loadBasis,
      equipmentId,
      isMainLift: false,
    })
    .returning({ id: exercises.id });
  if (!row) throw new Error("Failed to create exercise.");
  return { id: row.id, created: true };
}

async function insertOverrides(
  tx: Q,
  r: ResolvedSwap,
  toId: number,
  itemIds: number[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const plannedItemId of itemIds) {
    const [row] = await tx
      .insert(sessionOverrides)
      .values({
        sessionDate: r.referenceDate,
        plannedItemId,
        replacedExerciseId: r.from.id,
        replacementExerciseId: toId,
      })
      .onConflictDoNothing()
      .returning({ id: sessionOverrides.id });
    if (row) ids.push(row.id);
  }
  return ids;
}

async function loggedFrom(tx: Q, r: ResolvedSwap): Promise<boolean> {
  const [g] = await tx
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(and(eq(logGroups.sessionDate, r.referenceDate), eq(logGroups.exerciseId, r.from.id)))
    .limit(1);
  return g !== undefined;
}

export async function executeSwap(
  tx: Q,
  r: ResolvedSwap,
  alias: string,
  today: string,
): Promise<SwapOutcome> {
  if (r.scope === null) throw new Error("A swap without a scope cannot be saved.");
  const logged = await loggedFrom(tx, r);
  const loggedReply = `You already logged ${r.from.name} ${dateWords(r.referenceDate, today)}; nothing changed.`;

  if (r.scope === "today") {
    if (logged) return { refused: loggedReply };
    if (r.todayItemIds.length === 0) {
      return { refused: `${r.from.name} isn't in the plan for that day; nothing changed.` };
    }
    const to = await ensureExercise(tx, r, alias);
    const overrideIds = await insertOverrides(tx, r, to.id, r.todayItemIds);
    return {
      kind: "plan_change",
      overrideIds,
      versionId: null,
      createdExerciseId: to.created ? to.id : null,
    };
  }

  // Rest of the plan.
  let weekdays: ResolvedSwap["referenceWeekday"][] | "all";
  if (r.days === "this_day") weekdays = [r.referenceWeekday];
  else if (r.days === "every_day" || (r.days === null && r.futureWeekdays.length <= 1)) {
    weekdays = "all";
  } else {
    return { refused: "Tell me which days to change, then confirm again." };
  }
  const tomorrow = addDays(today, 1);
  const effectiveFrom = r.referenceDate > tomorrow ? r.referenceDate : tomorrow;

  const [plan] = await tx.select({ id: plans.id }).from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) throw new Error("No plan found in the database.");

  const to = await ensureExercise(tx, r, alias);
  const latest = await loadLatestContent(tx, plan.id);

  const [fromRow] = await tx
    .select({ type: exercises.type })
    .from(exercises)
    .where(eq(exercises.id, r.from.id));
  const optionIds = [...new Set(latest.content.items.flatMap((i) => i.optionExerciseIds))];
  const rows = optionIds.length
    ? await tx
        .select({ id: exercises.id, type: exercises.type, isMainLift: exercises.isMainLift })
        .from(exercises)
        .where(inArray(exercises.id, optionIds))
    : [];
  const byId = new Map(rows.map((x) => [x.id, x]));
  const [toRow] = await tx
    .select({ id: exercises.id, type: exercises.type, isMainLift: exercises.isMainLift })
    .from(exercises)
    .where(eq(exercises.id, to.id));
  if (toRow) byId.set(to.id, toRow);

  const applied = applySwap(latest.content, {
    fromExerciseId: r.from.id,
    toExerciseId: to.id,
    fromDate: effectiveFrom,
    weekdays,
    clearHspuStep: fromRow?.type === "skill_ladder",
    rirFor: (item, newOptionIds, weekIsDeload) => {
      const { rir_min, rir_max } = computeRir({
        options: newOptionIds.flatMap((id) => {
          const o = byId.get(id);
          return o ? [{ type: o.type, is_main_lift: o.isMainLift }] : [];
        }),
        modifiers: item.modifiers as Modifier[],
        weekIsDeload,
      });
      return { rirMin: rir_min, rirMax: rir_max };
    },
  });

  let versionId: number;
  try {
    const v = await createVersion(tx, {
      planId: plan.id,
      baseVersionId: latest.versionId,
      content: applied.content,
      effectiveFrom,
      reason: `swap ${r.from.name} → ${r.to.name}`,
      change: {
        kind: "swap",
        from: r.from.id,
        to: to.id,
        weekdays,
        fromDate: effectiveFrom,
      },
    });
    versionId = v.versionId;
  } catch (e) {
    if (e instanceof StaleBaseVersionError) {
      return { refused: "The plan changed meanwhile, try again." };
    }
    throw e;
  }

  let overrideIds: number[] = [];
  if (r.referenceDate === today && !logged && r.todayItemIds.length > 0) {
    overrideIds = await insertOverrides(tx, r, to.id, r.todayItemIds);
  }
  return {
    kind: "plan_change",
    overrideIds,
    versionId,
    createdExerciseId: to.created ? to.id : null,
  };
}
