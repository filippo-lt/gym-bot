/**
 * Swap staging (M7): turns what the model said into a ResolvedSwap. Pure code decides the
 * reference day, which weekdays are affected and how many sessions change; the model only
 * names the exercises. Nothing here writes (saving is a later step). Reads are sequential on
 * purpose (session pooler pipelining hazard).
 */
import { and, eq } from "drizzle-orm";
import { logGroups } from "../db/schema/log.js";
import { equipment } from "../db/schema/plan.js";
import { weekdayOf } from "../domain/calendar.js";
import { type CatalogExercise, loadCatalog, loadLadder } from "../logging/catalog.js";
import type { Q } from "../logging/db.js";
import { normalizeAlias } from "../logging/memory.js";
import { loadDayPlan, loadPlanContext } from "../logging/plan-context.js";
import { dateForDay, pickExercise } from "../logging/resolve.js";
import type { ResolvedSwap, SwapExerciseInput } from "../logging/types.js";
import { addDays } from "../plan-import/build-plan.js";
import type { Weekday } from "../plan-import/types.js";
import { loadVersionIndex, type PlanDayItem, planDayFromIndex } from "./effective.js";
import { itemDate } from "./swap-transform.js";
import { loadLatestContent } from "./versions.js";

export const WEEKDAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

/** Which question the flow must ask before the card, or null when the card can be shown. */
export function swapQuestion(r: ResolvedSwap): "scope" | "days" | null {
  if (r.scope === null) return "scope";
  if (
    r.scope === "rest" &&
    r.days === null &&
    r.futureWeekdays.length > 1 &&
    r.futureWeekdays.includes(r.referenceWeekday)
  ) {
    return "days";
  }
  return null;
}

function sessionsFor(r: ResolvedSwap, days: ResolvedSwap["days"]): number {
  if (days === "this_day") return r.sessionsByWeekday[r.referenceWeekday] ?? 0;
  return Object.values(r.sessionsByWeekday).reduce((a, b) => a + b, 0);
}

/** Applies a button answer (`sw:` t / r / d / a) and recounts the sessions for the new `days`. */
export function applySwapAnswer(r: ResolvedSwap, ans: "t" | "r" | "d" | "a"): ResolvedSwap {
  const next: ResolvedSwap = { ...r };
  if (ans === "t") next.scope = "today";
  if (ans === "r") next.scope = "rest";
  if (ans === "d") next.days = "this_day";
  if (ans === "a") next.days = "every_day";
  next.affectedSessions = sessionsFor(next, next.days);
  return next;
}

/** lowercase, runs of non-alphanumerics become one "_", trimmed. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const range = (min: number | null, max: number | null): string | null =>
  min === null || max === null ? null : min === max ? String(min) : `${min}–${max}`;

/** "3 × 15" from the planned item's own fields. */
function prescriptionOf(item: PlanDayItem): string | null {
  const sets = range(item.setsMin, item.setsMax);
  const reps = range(item.repsMin, item.repsMax);
  return sets && reps ? `${sets} × ${reps}` : null;
}

const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(", ");

export type SwapResolution = { ok: true; resolved: ResolvedSwap } | { ok: false; reply: string };

export async function resolveSwap(
  db: Q,
  input: SwapExerciseInput,
  today: string,
): Promise<SwapResolution> {
  const refuse = (reply: string): SwapResolution => ({ ok: false, reply });
  const index = await loadVersionIndex(db);
  const version = index.versionFor(today);
  if (!version) return refuse("There is no plan yet.");

  const catalog = await loadCatalog(db);
  const ladder = await loadLadder(db);

  // A replacement that is an HSPU ladder step is not a plan change (the step is tracked from logs).
  // The same check runs on the name of a `new` exercise, so it cannot slip through that way.
  const isLadderStep = (said: string, slug?: string): boolean => {
    const norm = normalizeAlias(said);
    return ladder.some(
      (l) =>
        normalizeAlias(l.name) === norm ||
        l.slug === norm.replaceAll(" ", "_") ||
        l.slug === slugFromName(said) ||
        (slug !== undefined && l.slug === slug),
    );
  };
  if (
    isLadderStep(input.replacement.said, input.replacement.slug) ||
    (input.replacement.new && isLadderStep(input.replacement.new.name))
  ) {
    return refuse(
      "That is an HSPU step. The HSPU step is tracked from your logs, so I changed nothing.",
    );
  }

  const ctx = await loadPlanContext(db, today);
  const target = await loadDayPlan(db, ctx, today);

  const fromPick = await pickExercise(db, input.exercise, catalog, target);
  if (fromPick.kind === "clarify") {
    return refuse(
      fromPick.candidates.length > 0
        ? `Which exercise do you mean: ${names(fromPick.candidates)}?`
        : "Which exercise do you want to replace? Tell me its name.",
    );
  }
  const from = fromPick.exercise;

  // Replacement: the catalog wins; `new` only applies when nothing in the catalog fits.
  const toPick = await pickExercise(db, input.replacement, catalog, target);
  let to: ResolvedSwap["to"];
  if (toPick.kind === "ok") {
    to = catalogTarget(toPick.exercise);
  } else if (input.replacement.new) {
    const spec = input.replacement.new;
    const slug = slugFromName(spec.name);
    const existing = catalog.find((c) => c.slug === slug);
    if (existing) {
      to = catalogTarget(existing);
    } else {
      const describeAgain =
        "Please describe the new exercise again: its name, type and muscle group.";
      if (!slug) return refuse(describeAgain);
      if (spec.equipment_slug) {
        const [eq1] = await db
          .select({ id: equipment.id })
          .from(equipment)
          .where(eq(equipment.slug, spec.equipment_slug))
          .limit(1);
        if (!eq1) return refuse(`I don't know that equipment. ${describeAgain}`);
      }
      to = {
        id: null,
        name: spec.name.trim(),
        slug,
        isNew: true,
        newSpec: {
          type: spec.type,
          loadBasis: spec.load_basis ?? null,
          equipmentSlug: spec.equipment_slug ?? null,
          muscleGroup: spec.muscle_group.trim(),
        },
      };
    }
  } else {
    return refuse(
      toPick.candidates.length > 0
        ? `Did you mean ${names(toPick.candidates)}? If it is a new exercise, describe it: its name, type and muscle group.`
        : "I don't know that exercise. If it is new, describe it: its name, type and muscle group.",
    );
  }
  if (to.id === from.id) return refuse("That is the same exercise, so nothing changes.");

  // Reference day: the named day, else today; if the exercise is not there, the next session that has it.
  const holds = async (date: string): Promise<PlanDayItem[] | null> => {
    const day = await planDayFromIndex(db, index, date);
    if (day.kind !== "day") return null;
    const hits = day.items.filter((i) => i.options.some((o) => o.id === from.id));
    return hits.length > 0 ? hits : null;
  };
  let refDate: string | null = null;
  let refItems: PlanDayItem[] | null = null;
  if (input.day && input.day !== "today") {
    // A weekday already past this week means next week's.
    let named = dateForDay(ctx, today, input.day);
    if (named < today) named = addDays(named, 7);
    refItems = await holds(named);
    if (refItems) refDate = named;
  }
  if (!refItems) {
    const maxDays = Math.max(...index.versions.map((v) => v.weeks), 1) * 7;
    for (let i = 0; i <= maxDays && !refItems; i++) {
      const date = addDays(today, i);
      const day = await planDayFromIndex(db, index, date);
      if (day.kind === "finished" || day.kind === "no_plan") break;
      refItems = await holds(date);
      if (refItems) refDate = date;
    }
  }
  if (!refItems || !refDate) return refuse(`${from.name} isn't in the plan from today on.`);
  const referenceWeekday = weekdayOf(refDate) as Weekday;

  // Future sessions of the latest version that would change.
  const effectiveFrom = refDate > addDays(today, 1) ? refDate : addDays(today, 1);
  const latest = await loadLatestContent(db, version.planId);
  const datesByWeekday = new Map<Weekday, Set<string>>();
  for (const it of latest.content.items) {
    if (!it.optionExerciseIds.includes(from.id)) continue;
    const date = itemDate(latest.content, it);
    if (date < effectiveFrom) continue;
    const set = datesByWeekday.get(it.weekday) ?? new Set<string>();
    set.add(date);
    datesByWeekday.set(it.weekday, set);
  }
  const futureWeekdays = WEEKDAY_ORDER.filter((w) => datesByWeekday.has(w));
  const sessionsByWeekday: ResolvedSwap["sessionsByWeekday"] = {};
  for (const w of futureWeekdays) sessionsByWeekday[w] = datesByWeekday.get(w)?.size ?? 0;

  const [logged] = await db
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(and(eq(logGroups.sessionDate, refDate), eq(logGroups.exerciseId, from.id)))
    .limit(1);

  const scope = input.scope ?? null;
  let days: ResolvedSwap["days"] = scope === "today" ? null : (input.days ?? null);
  const only = futureWeekdays[0];
  if (days === null && only !== undefined && futureWeekdays.length === 1) {
    // One weekday left: nothing to ask. "every_day" when it is not the reference weekday keeps
    // that weekday in (this_day would restrict to the reference weekday).
    days = only === referenceWeekday ? "this_day" : "every_day";
  } else if (
    days === null &&
    futureWeekdays.length > 0 &&
    !futureWeekdays.includes(referenceWeekday)
  ) {
    // "This day" would match no later session, so it is not offered.
    days = "every_day";
  }

  const resolved: ResolvedSwap = {
    from: { id: from.id, name: from.name },
    to,
    referenceDate: refDate,
    scope,
    days,
    referenceWeekday,
    futureWeekdays,
    todayItemIds: refItems.map((i) => i.plannedItemId),
    loggedOnReference: logged !== undefined,
    affectedSessions: 0,
    sessionsByWeekday,
    prescription: prescriptionOf(refItems[0] as PlanDayItem),
  };
  resolved.affectedSessions = sessionsFor(resolved, resolved.days);
  return { ok: true, resolved };
}

function catalogTarget(c: CatalogExercise): ResolvedSwap["to"] {
  return { id: c.id, name: c.name, slug: c.slug, isNew: false, newSpec: null };
}
