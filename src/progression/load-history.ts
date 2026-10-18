/**
 * DB -> engine input (M5). Every read is sequential on purpose: the session pooler hangs on pipelined queries.
 * Nothing here writes. Dates are Rome ISO days; history is strictly before the session date.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import {
  bodyweightLogs,
  classLogs,
  logEntries,
  logGroups,
  weeklyMetrics,
} from "../db/schema/log.js";
import {
  equipment,
  exercises,
  hspuLadder,
  plannedItemOptions,
  plannedItems,
  plans,
  planVersions,
  planWeeks,
} from "../db/schema/plan.js";
import { proposals, readinessLogs, suggestions } from "../db/schema/progression.js";
import { trainingDate, weekdayOf } from "../domain/calendar.js";
import type { Q } from "../logging/db.js";
import type { Modifier, Priority, Tag, Weekday } from "../plan-import/types.js";
import { gateEventsFrom } from "./pullup.js";
import { driftFor } from "./readiness.js";
import type {
  ExerciseInfo,
  GateEvent,
  HeavyGroup,
  HspuLadderStep,
  ItemOccurrence,
  ItemTarget,
  ReadinessLevel,
  ReadinessSignal,
  SessionInput,
  SessionRec,
  SetRec,
} from "./types.js";

/** Derived (frozen-level) rows need a valid `kind`; `button_ok` adds nothing, and these rows are never read as signals. */
export const DERIVED_KIND = "button_ok";
export const PULLUP_METRIC = "pullups";
export const RECOVERY_METRIC = "recovery";
/** Recovery at or below this score is a readiness signal (SPEC 5.6b/c). */
export const RECOVERY_LOW_MAX = 2;

const WEEKDAY_OFFSET: Record<Weekday, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4 };
/** Signals that can still matter: recovery lives 3 days, chat/button 24 h. */
const SIGNAL_LOOKBACK_DAYS = 4;

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate() as string;
}

function romeAt(date: string, time: string): string {
  return (
    DateTime.fromISO(`${date}T${time}`, { zone: APP_TIMEZONE }).toUTC().toISO() ??
    `${date}T${time}Z`
  );
}

// ---------------------------------------------------------------------------
// Plan environment
// ---------------------------------------------------------------------------

export interface WeekRow {
  versionId: number;
  week: number;
  isDeload: boolean;
  isTest: boolean;
  startDate: string;
}

export interface PlanEnv {
  startDate: string;
  versions: { id: number; version: number; effectiveFrom: string }[];
  weeksByVersion: Map<number, WeekRow[]>;
}

export async function loadPlanEnv(q: Q): Promise<PlanEnv | null> {
  const [plan] = await q.select().from(plans).orderBy(desc(plans.id)).limit(1);
  if (!plan) return null;
  const versions = await q
    .select({
      id: planVersions.id,
      version: planVersions.version,
      effectiveFrom: planVersions.effectiveFrom,
    })
    .from(planVersions)
    .where(eq(planVersions.planId, plan.id))
    .orderBy(asc(planVersions.version));
  if (versions.length === 0) return null;
  const weekRows = await q
    .select()
    .from(planWeeks)
    .where(
      inArray(
        planWeeks.planVersionId,
        versions.map((v) => v.id),
      ),
    )
    .orderBy(asc(planWeeks.week));
  const weeksByVersion = new Map<number, WeekRow[]>();
  for (const w of weekRows) {
    const list = weeksByVersion.get(w.planVersionId) ?? [];
    list.push({
      versionId: w.planVersionId,
      week: w.week,
      isDeload: w.isDeload,
      isTest: w.isTest,
      startDate: w.startDate,
    });
    weeksByVersion.set(w.planVersionId, list);
  }
  return { startDate: plan.startDate, versions, weeksByVersion };
}

/** Version rule shared with src/logging/plan-context.ts: latest version effective on `date`, else the first. */
export function versionIdFor(env: PlanEnv, date: string): number {
  const effective = env.versions.filter((v) => v.effectiveFrom <= date);
  const pick = effective.length > 0 ? effective[effective.length - 1] : env.versions[0];
  return (pick as { id: number }).id;
}

/** The plan week containing `date` (version effective on that date); null outside the plan. */
export function weekFor(env: PlanEnv, date: string): WeekRow | null {
  const rows = env.weeksByVersion.get(versionIdFor(env, date)) ?? [];
  for (const w of rows) if (w.startDate <= date && date <= addDays(w.startDate, 6)) return w;
  return null;
}

function weekDate(row: WeekRow, weekday: Weekday): string {
  return addDays(row.startDate, WEEKDAY_OFFSET[weekday]);
}

/** Friday of a plan week (weekly metrics are dated there). Latest version that has the week. */
function fridayOfWeek(env: PlanEnv, week: number): string {
  for (let i = env.versions.length - 1; i >= 0; i--) {
    const v = env.versions[i];
    const row = (env.weeksByVersion.get((v as { id: number }).id) ?? []).find(
      (w) => w.week === week,
    );
    if (row) return weekDate(row, "fri");
  }
  return addDays(env.startDate, (week - 1) * 7 + 4);
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

export async function loadExerciseInfos(
  q: Q,
  ids: number[],
): Promise<Record<number, ExerciseInfo>> {
  const out: Record<number, ExerciseInfo> = {};
  if (ids.length === 0) return out;
  const rows = await q
    .select({ ex: exercises, eq: equipment })
    .from(exercises)
    .leftJoin(equipment, eq(equipment.id, exercises.equipmentId))
    .where(inArray(exercises.id, ids));
  for (const { ex, eq: e } of rows) {
    out[ex.id] = {
      id: ex.id,
      slug: ex.slug,
      type: ex.type,
      loadBasis: ex.loadBasis,
      isMainLift: ex.isMainLift,
      equipment: e
        ? {
            slug: e.slug,
            baseKg: e.baseKg,
            stepKg: e.stepKg,
            discreteValues: e.discreteValues,
            bands: e.bands ?? {},
          }
        : null,
    };
  }
  return out;
}

/** The pull-up exercise: the `bodyweight_plus` one (slug `pull_up` first). */
export async function loadPullupExercise(q: Q): Promise<ExerciseInfo | null> {
  const rows = await q
    .select({ id: exercises.id, slug: exercises.slug })
    .from(exercises)
    .where(eq(exercises.type, "bodyweight_plus"))
    .orderBy(asc(exercises.id));
  const pick = rows.find((r) => r.slug === "pull_up") ?? rows[0];
  if (!pick) return null;
  return (await loadExerciseInfos(q, [pick.id]))[pick.id] ?? null;
}

export async function loadHspuLadder(q: Q): Promise<HspuLadderStep[]> {
  const rows = await q.select().from(hspuLadder).orderBy(asc(hspuLadder.stepOrder));
  return rows.map((r) => ({
    id: r.id,
    stepOrder: r.stepOrder,
    slug: r.slug,
    name: r.name,
    defaultSets: r.defaultSets,
    defaultRepsMin: r.defaultRepsMin,
    defaultRepsMax: r.defaultRepsMax,
    tempo: r.tempo,
  }));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * The step of the newest accepted "advance HSPU" proposal, as long as the exercise has no log after it (SPEC 5.2: the
 * step is user state taken from the last log; an accepted proposal stands in until a newer log exists).
 */
export async function acceptedHspuStep(
  q: Q,
  exerciseId: number,
): Promise<{ stepOrder: number; decidedAt: Date } | null> {
  const [p] = await q
    .select()
    .from(proposals)
    .where(and(eq(proposals.kind, "hspu_advance"), eq(proposals.status, "accepted")))
    .orderBy(desc(proposals.decidedAt), desc(proposals.id))
    .limit(1);
  const to = (p?.payload as { toStepOrder?: unknown } | undefined)?.toStepOrder;
  if (!p?.decidedAt || typeof to !== "number") return null;
  const [newer] = await q
    .select({ id: logGroups.id })
    .from(logGroups)
    .where(and(eq(logGroups.exerciseId, exerciseId), gt(logGroups.performedAt, p.decidedAt)))
    .limit(1);
  return newer ? null : { stepOrder: to, decidedAt: p.decidedAt };
}

/**
 * Session records per exercise, newest first, log groups of one day merged in set order.
 * `beforeDate` is exclusive (null = all history). Band sets take their kg from equipment.bands (unmapped -> null).
 */
export async function loadSessionRecs(
  q: Q,
  env: PlanEnv,
  infos: Record<number, ExerciseInfo>,
  exerciseIds: number[],
  beforeDate: string | null,
): Promise<Map<number, SessionRec[]>> {
  const out = new Map<number, SessionRec[]>();
  if (exerciseIds.length === 0) return out;
  const conds = [inArray(logGroups.exerciseId, exerciseIds)];
  if (beforeDate) conds.push(lt(logGroups.sessionDate, beforeDate));
  const rows = await q
    .select({
      g: logGroups,
      e: logEntries,
      stepOrder: hspuLadder.stepOrder,
      sug: suggestions,
    })
    .from(logGroups)
    .innerJoin(logEntries, eq(logEntries.groupId, logGroups.id))
    .leftJoin(hspuLadder, eq(hspuLadder.id, logGroups.hspuStepId))
    .leftJoin(suggestions, eq(suggestions.id, logGroups.suggestionId))
    .where(and(...conds))
    .orderBy(
      asc(logGroups.sessionDate),
      asc(logGroups.performedAt),
      asc(logGroups.id),
      asc(logEntries.setIndex),
    );

  const byKey = new Map<string, SessionRec>();
  const allImport = new Map<string, boolean>();
  const seenGroup = new Map<string, Set<number>>();
  for (const { g, e, stepOrder, sug } of rows) {
    const key = `${g.exerciseId}|${g.sessionDate}`;
    let rec = byKey.get(key);
    if (!rec) {
      const wk = weekFor(env, g.sessionDate);
      rec = {
        date: g.sessionDate,
        exerciseId: g.exerciseId,
        plannedItemIds: [],
        source: "import",
        bwKg: null,
        week: wk?.week ?? null,
        isDeload: wk?.isDeload ?? false,
        isTest: wk?.isTest ?? false,
        readiness: null,
        perSetUnknown: false,
        hspuStepOrder: null,
        padHeight: null,
        suggestion: null,
        sets: [],
      };
      byKey.set(key, rec);
      allImport.set(key, true);
      seenGroup.set(key, new Set());
    }
    const seen = seenGroup.get(key) as Set<number>;
    if (!seen.has(g.id)) {
      seen.add(g.id);
      if (g.source !== "import") allImport.set(key, false);
      if (g.plannedItemId != null && !rec.plannedItemIds.includes(g.plannedItemId)) {
        rec.plannedItemIds.push(g.plannedItemId);
      }
      if (rec.bwKg == null && g.bwKg != null) rec.bwKg = g.bwKg;
      if (rec.readiness == null && g.readinessLevel != null) rec.readiness = g.readinessLevel;
      if (g.perSetUnknown) rec.perSetUnknown = true;
      if (stepOrder != null) rec.hspuStepOrder = stepOrder;
      if (rec.suggestion == null && sug != null) {
        rec.suggestion = {
          id: sug.id,
          systemLoad: sug.systemLoad,
          repsMin: sug.repsMin,
          rirMid: sug.rirMid,
        };
      }
    }
    if (e.padHeight != null) rec.padHeight = e.padHeight;

    const bands = infos[g.exerciseId]?.equipment?.bands ?? {};
    const mapped = e.band != null ? bands[e.band] : undefined;
    const set: SetRec = {
      reps: e.reps,
      loadKg: e.loadKg,
      addedKg: e.addedKg,
      // A band decides the assistance; an unmapped band has no load math (assistKg null).
      assistKg: e.band != null ? (mapped ?? null) : e.assistKg,
      band: e.band,
      rir: e.rir,
      rirPlus: e.rirPlus,
      clean: e.clean,
      durationS: e.durationS,
    };
    rec.sets.push(set);
  }
  for (const [key, rec] of byKey) {
    rec.source = allImport.get(key) ? "import" : "bot";
    const list = out.get(rec.exerciseId) ?? [];
    list.push(rec);
    out.set(rec.exerciseId, list);
  }
  for (const list of out.values())
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // An accepted HSPU advance stands in as a set-less session at the new step until a newer log exists.
  for (const id of exerciseIds) {
    if (infos[id]?.type !== "skill_ladder") continue;
    const accepted = await acceptedHspuStep(q, id);
    if (!accepted) continue;
    const date = trainingDate(accepted.decidedAt);
    if (beforeDate && date > beforeDate) continue;
    const list = out.get(id) ?? [];
    list.unshift({
      date,
      exerciseId: id,
      plannedItemIds: [],
      source: "bot",
      bwKg: null,
      week: weekFor(env, date)?.week ?? null,
      isDeload: false,
      isTest: false,
      readiness: null,
      perSetUnknown: false,
      hspuStepOrder: accepted.stepOrder,
      padHeight: null,
      suggestion: null,
      sets: [],
    });
    out.set(id, list);
  }
  return out;
}

/**
 * Pull-up gate events (SPEC 5.2): clean bodyweight sets, each session's implied reps, and check-in / test maxes from
 * weekly_metrics (`pullups`, dated to that week's Friday). `beforeDate` exclusive; null = everything.
 */
export async function loadGateEvents(
  q: Q,
  env: PlanEnv,
  pullup: ExerciseInfo,
  beforeDate: string | null,
  recs?: SessionRec[],
): Promise<GateEvent[]> {
  const sessions =
    recs ??
    (await loadSessionRecs(q, env, { [pullup.id]: pullup }, [pullup.id], beforeDate)).get(
      pullup.id,
    ) ??
    [];
  const metricRows = await q
    .select({ week: weeklyMetrics.planWeek, value: weeklyMetrics.valueNum })
    .from(weeklyMetrics)
    .where(eq(weeklyMetrics.metric, PULLUP_METRIC));
  const metrics = metricRows
    .filter((m) => m.value != null)
    .map((m) => ({ date: fridayOfWeek(env, m.week), maxCleanReps: m.value as number }))
    .filter((m) => beforeDate == null || m.date < beforeDate);
  return gateEventsFrom(sessions, metrics, pullup);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export async function loadFrozenLevel(q: Q, date: string): Promise<ReadinessLevel | null> {
  const [row] = await q
    .select({ level: readinessLogs.level })
    .from(readinessLogs)
    .where(and(eq(readinessLogs.date, date), eq(readinessLogs.source, "derived")))
    .orderBy(desc(readinessLogs.id))
    .limit(1);
  return (row?.level as ReadinessLevel | null | undefined) ?? null;
}

/**
 * Drift signals (SPEC 5.6c): for every lift whose newest session before `date` has a stored suggestion, drift of that
 * session. Once the lift is logged again its newest session is the later one, so an old drift disappears by itself.
 */
export async function loadDriftSignals(
  q: Q,
  env: PlanEnv,
  date: string,
): Promise<ReadinessSignal[]> {
  const lifts = await q
    .selectDistinct({ id: logGroups.exerciseId })
    .from(logGroups)
    .where(and(isNotNull(logGroups.suggestionId), lt(logGroups.sessionDate, date)));
  const ids = lifts.map((l) => l.id);
  if (ids.length === 0) return [];
  const infos = await loadExerciseInfos(q, ids);
  const recs = await loadSessionRecs(q, env, infos, ids, date);
  const out: ReadinessSignal[] = [];
  for (const id of ids) {
    const latest = recs.get(id)?.[0];
    if (!latest?.suggestion) continue;
    // The session carries its own deload/test flags; the stub target only satisfies the signature.
    const stub = { isDeload: false, isTest: false } as ItemTarget;
    if (driftFor(latest, stub)) {
      out.push({ at: romeAt(latest.date, "23:00:00"), kind: "drift", lift: id });
    }
  }
  return out;
}

/** All still-relevant signals for `date`: button/chat rows, weekly recovery <= 2, drift. Derived rows are not signals. */
export async function loadReadinessSignals(
  q: Q,
  env: PlanEnv,
  date: string,
): Promise<ReadinessSignal[]> {
  const rows = await q
    .select()
    .from(readinessLogs)
    .where(
      and(
        lte(readinessLogs.date, date),
        sql`${readinessLogs.date} >= ${addDays(date, -SIGNAL_LOOKBACK_DAYS)}`,
        sql`${readinessLogs.source} <> 'derived'`,
        sql`${readinessLogs.kind} <> 'drift'`,
      ),
    )
    .orderBy(asc(readinessLogs.at));
  const out: ReadinessSignal[] = rows.map((r) => ({
    at: r.at.toISOString(),
    kind: r.kind as ReadinessSignal["kind"],
  }));

  const recovery = await q
    .select({ week: weeklyMetrics.planWeek, value: weeklyMetrics.valueNum })
    .from(weeklyMetrics)
    .where(eq(weeklyMetrics.metric, RECOVERY_METRIC));
  for (const r of recovery) {
    if (r.value == null || r.value > RECOVERY_LOW_MAX) continue;
    const friday = fridayOfWeek(env, r.week);
    if (friday > date || friday < addDays(date, -SIGNAL_LOOKBACK_DAYS)) continue;
    out.push({ at: romeAt(friday, "20:00:00"), kind: "recovery_low" });
  }
  out.push(...(await loadDriftSignals(q, env, date)));
  return out;
}

// ---------------------------------------------------------------------------
// Session input
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** /short for this session. */
  short?: boolean;
}

async function lastTrainingBefore(q: Q, date: string): Promise<string | null> {
  const [g] = await q
    .select({ d: sql<string | null>`max(${logGroups.sessionDate})` })
    .from(logGroups)
    .where(lt(logGroups.sessionDate, date));
  const [c] = await q
    .select({ d: sql<string | null>`max(${classLogs.date})` })
    .from(classLogs)
    .where(lt(classLogs.date, date));
  const days = [g?.d, c?.d].filter((d): d is string => !!d);
  return days.length ? (days.sort().at(-1) ?? null) : null;
}

/** Same slot in earlier non-deload weeks (same weekday, sub item and option set); logged = a group on that day. */
async function loadOccurrences(
  q: Q,
  env: PlanEnv,
  versionId: number,
  weekday: Weekday,
  week: number,
  date: string,
  today: { id: number; subItem: number; optionIds: number[] }[],
): Promise<ItemOccurrence[]> {
  if (today.length === 0) return [];
  const weeks = (env.weeksByVersion.get(versionId) ?? []).filter(
    (w) => w.week < week && !w.isDeload && weekDate(w, weekday) < date,
  );
  if (weeks.length === 0) return today.map((t) => ({ plannedItemId: t.id, occurrences: [] }));
  const weekByNumber = new Map(weeks.map((w) => [w.week, w]));
  const items = await q
    .select({ id: plannedItems.id, week: plannedItems.week, subItem: plannedItems.subItem })
    .from(plannedItems)
    .where(
      and(
        eq(plannedItems.planVersionId, versionId),
        eq(plannedItems.weekday, weekday),
        inArray(
          plannedItems.week,
          weeks.map((w) => w.week),
        ),
      ),
    );
  const itemIds = items.map((i) => i.id);
  const optionRows = itemIds.length
    ? await q
        .select({
          itemId: plannedItemOptions.plannedItemId,
          exerciseId: plannedItemOptions.exerciseId,
        })
        .from(plannedItemOptions)
        .where(inArray(plannedItemOptions.plannedItemId, itemIds))
    : [];
  const optionsOf = new Map<number, number[]>();
  for (const o of optionRows) {
    const list = optionsOf.get(o.itemId) ?? [];
    list.push(o.exerciseId);
    optionsOf.set(o.itemId, list);
  }
  const dates = weeks.map((w) => weekDate(w, weekday));
  const allOptionIds = [...new Set(optionRows.map((o) => o.exerciseId))];
  const groupRows =
    dates.length && itemIds.length
      ? await q
          .select({
            d: logGroups.sessionDate,
            p: logGroups.plannedItemId,
            e: logGroups.exerciseId,
          })
          .from(logGroups)
          .where(
            and(
              inArray(logGroups.sessionDate, dates),
              sql`(${inArray(logGroups.plannedItemId, itemIds)} or ${inArray(logGroups.exerciseId, allOptionIds)})`,
            ),
          )
      : [];
  const plannedLogged = new Set(groupRows.filter((g) => g.p != null).map((g) => g.p as number));
  const exLogged = new Set(groupRows.map((g) => `${g.d}|${g.e}`));

  const sameSet = (a: number[], b: number[]) => {
    const x = [...a].sort((m, n) => m - n).join(",");
    const y = [...b].sort((m, n) => m - n).join(",");
    return x === y;
  };
  return today.map((t) => {
    const occurrences: ItemOccurrence["occurrences"] = [];
    for (const it of items) {
      if (it.subItem !== t.subItem) continue;
      const opts = optionsOf.get(it.id) ?? [];
      if (!sameSet(opts, t.optionIds)) continue;
      const wk = weekByNumber.get(it.week);
      if (!wk) continue;
      const d = weekDate(wk, weekday);
      const logged = plannedLogged.has(it.id) || opts.some((o) => exLogged.has(`${d}|${o}`));
      occurrences.push({ date: d, logged });
    }
    occurrences.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { plannedItemId: t.id, occurrences };
  });
}

/**
 * Everything `planSession` needs for the session of `date`, or null when the date has no session (weekend,
 * outside the plan). Uses the plan version effective on that date.
 */
export async function loadSessionInput(
  q: Q,
  date: string,
  opts: LoadOptions = {},
): Promise<SessionInput | null> {
  const env = await loadPlanEnv(q);
  if (!env) return null;
  const weekday = weekdayOf(date);
  const wk = weekFor(env, date);
  if (!weekday || !wk) return null;

  const rows = await q
    .select({ item: plannedItems, stepOrder: hspuLadder.stepOrder })
    .from(plannedItems)
    .leftJoin(hspuLadder, eq(hspuLadder.id, plannedItems.hspuStepId))
    .where(
      and(
        eq(plannedItems.planVersionId, wk.versionId),
        eq(plannedItems.week, wk.week),
        eq(plannedItems.weekday, weekday),
      ),
    )
    .orderBy(asc(plannedItems.itemOrder), asc(plannedItems.subItem));
  const ids = rows.map((r) => r.item.id);
  const optionRows = ids.length
    ? await q
        .select()
        .from(plannedItemOptions)
        .where(inArray(plannedItemOptions.plannedItemId, ids))
        .orderBy(asc(plannedItemOptions.plannedItemId), asc(plannedItemOptions.optionIndex))
    : [];
  const optionIds = [...new Set(optionRows.map((o) => o.exerciseId))];
  const infos = await loadExerciseInfos(q, optionIds);

  const items: ItemTarget[] = rows.map(({ item: r, stepOrder }) => ({
    plannedItemId: r.id,
    subItem: r.subItem,
    exerciseIds: optionRows.filter((o) => o.plannedItemId === r.id).map((o) => o.exerciseId),
    setsMin: r.setsMin,
    setsMax: r.setsMax,
    repsMin: r.repsMin,
    repsMax: r.repsMax,
    rirMin: r.rirMin,
    rirMax: r.rirMax,
    modifiers: r.modifiers as Modifier[],
    tags: r.tags as Tag[],
    priority: r.priority as Priority,
    isDeload: wk.isDeload,
    isTest: (r.modifiers as string[]).includes("test"),
    hiit: r.hiit,
    fallback: r.fallbackPrescription,
    hspuStepOrder: stepOrder ?? null,
    order: r.itemOrder,
    planName: r.planName,
  }));

  const recs = await loadSessionRecs(q, env, infos, optionIds, date);
  const history: Record<number, SessionRec[]> = {};
  for (const id of optionIds) history[id] = recs.get(id) ?? [];

  const [bwRow] = await q
    .select()
    .from(bodyweightLogs)
    .where(lte(bodyweightLogs.date, date))
    .orderBy(desc(bodyweightLogs.date))
    .limit(1);

  const pullup = Object.values(infos).find((e) => e.type === "bodyweight_plus") ?? null;
  const gateEvents = pullup ? await loadGateEvents(q, env, pullup, date, history[pullup.id]) : [];

  const ladder = await loadHspuLadder(q);

  let heavyGroups: HeavyGroup[] = [];
  let classReported = true;
  if (weekday === "fri") {
    const [cls] = await q
      .select()
      .from(classLogs)
      .where(eq(classLogs.date, addDays(date, -1)));
    classReported = cls != null;
    heavyGroups = (cls?.heavyGroups ?? []) as HeavyGroup[];
  }

  const readinessSignals = await loadReadinessSignals(q, env, date);
  const frozenLevel = await loadFrozenLevel(q, date);
  const lastTrainingDate = await lastTrainingBefore(q, date);
  const occurrences = await loadOccurrences(
    q,
    env,
    wk.versionId,
    weekday,
    wk.week,
    date,
    items.map((i) => ({ id: i.plannedItemId, subItem: i.subItem, optionIds: i.exerciseIds })),
  );

  return {
    date,
    weekday,
    week: wk.week,
    isDeload: wk.isDeload,
    isTest: wk.isTest,
    items,
    history,
    exercises: infos,
    bodyweight: bwRow ? { kg: bwRow.kg, date: bwRow.date } : null,
    gateEvents,
    hspuLadder: ladder,
    heavyGroups,
    classReported,
    readinessSignals,
    frozenLevel,
    short: opts.short ?? false,
    lastTrainingDate,
    occurrences,
  };
}
