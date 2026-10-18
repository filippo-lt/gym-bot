/**
 * Persistence for the progression engine (M5): stored suggestions, the frozen readiness level, the derived-state cache.
 * Everything derives from history; these rows are the "what was shown" record (SPEC 5.2, 5.6c, 6).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import { logGroups } from "../db/schema/log.js";
import { exercises, hspuLadder } from "../db/schema/plan.js";
import { readinessLogs, suggestions, userState } from "../db/schema/progression.js";
import type { Db } from "../db/seed-plan.js";
import type { Q } from "../logging/db.js";
import { planSession } from "./engine.js";
import { hspuState } from "./hspu.js";
import {
  DERIVED_KIND,
  type LoadOptions,
  loadExerciseInfos,
  loadFrozenLevel,
  loadGateEvents,
  loadPlanEnv,
  loadPullupExercise,
  loadReadinessSignals,
  loadSessionInput,
  loadSessionRecs,
} from "./load-history.js";
import { gateState } from "./pullup.js";
import { readinessLevel } from "./readiness.js";
import type {
  AdjustedItem,
  AdjustedSession,
  Label,
  ReadinessLevel,
  ReadinessSignal,
  SessionInput,
  SessionRec,
  Suggestion,
} from "./types.js";

/** Key of one stored suggestion slot (date is implicit). */
export const suggestionKey = (plannedItemId: number, subItem: number, exerciseId: number): string =>
  `${plannedItemId}:${subItem}:${exerciseId}`;

type SuggestionRow = typeof suggestions.$inferSelect;

/** A stored row back as the engine's `Suggestion` (the `ask` flag is not stored: asks are never stored). */
export function suggestionFromRow(r: SuggestionRow): Suggestion {
  const s: Suggestion = {
    sets: r.sets,
    repsMin: r.repsMin,
    repsMax: r.repsMax,
    rirMin: r.rirMin,
    rirMax: r.rirMax,
    rirMid: r.rirMid,
    labels: r.labels as Label[],
  };
  if (r.loadKg != null) s.loadKg = r.loadKg;
  if (r.addedKg != null) s.addedKg = r.addedKg;
  if (r.assistKg != null) s.assistKg = r.assistKg;
  if (r.band != null) s.band = r.band;
  if (r.systemLoad != null) s.systemLoad = r.systemLoad;
  if (r.e1rmUsed != null) s.e1rmUsed = r.e1rmUsed;
  return s;
}

function toRowValues(
  date: string,
  plannedItemId: number,
  subItem: number,
  exerciseId: number,
  s: Suggestion,
  level: ReadinessLevel,
) {
  return {
    sessionDate: date,
    plannedItemId,
    subItem,
    exerciseId,
    sets: s.sets,
    repsMin: s.repsMin,
    repsMax: s.repsMax,
    rirMin: s.rirMin,
    rirMax: s.rirMax,
    rirMid: s.rirMid ?? (s.rirMin + s.rirMax) / 2,
    loadKg: s.loadKg ?? null,
    addedKg: s.addedKg ?? null,
    assistKg: s.assistKg ?? null,
    band: s.band ?? null,
    systemLoad: s.systemLoad ?? null,
    e1rmUsed: s.e1rmUsed ?? null,
    labels: s.labels,
    readinessLevel: level,
  };
}

export interface EnsureResult {
  input: SessionInput;
  /** The plan, with already-used (frozen) suggestions replaced by what was stored and shown. */
  session: AdjustedSession;
  /** Stored suggestion id per slot, see `suggestionKey`. */
  ids: Map<string, number>;
  /** Ids a log group already references: never changed again. */
  frozenIds: Set<number>;
}

function prescriptionOf(s: Suggestion) {
  return {
    sets: s.sets,
    repsMin: s.repsMin,
    repsMax: s.repsMax,
    rirMin: s.rirMin,
    rirMax: s.rirMax,
  };
}

/**
 * Compute `planSession` for `date` and store one suggestion per (item, sub item, option) that has numbers.
 * Idempotent. A row is only rewritten (or removed) while no log group references it: once the user logged against a
 * suggestion it is frozen and the returned session shows the stored values. Returns null when the date has no session.
 */
export async function ensureSuggestions(
  db: Db,
  date: string,
  opts: LoadOptions & { asOf?: string } = {},
): Promise<EnsureResult | null> {
  const input = await loadSessionInput(db, date, opts);
  if (!input) return null;
  const session = planSession(input, opts.asOf ? { asOf: opts.asOf } : {});

  const wanted = new Map<string, ReturnType<typeof toRowValues>>();
  for (const item of session.items) {
    for (const [exIdStr, s] of Object.entries(item.suggestions)) {
      if (!s || s.ask) continue;
      const exId = Number(exIdStr);
      wanted.set(
        suggestionKey(item.target.plannedItemId, item.target.subItem, exId),
        toRowValues(date, item.target.plannedItemId, item.target.subItem, exId, s, session.level),
      );
    }
  }

  const rows = await db.transaction(async (tx) => {
    // Serialise writers of the same date.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`suggestions:${date}`}))`);
    for (const values of wanted.values()) {
      await tx
        .insert(suggestions)
        .values(values)
        .onConflictDoUpdate({
          target: [
            suggestions.sessionDate,
            suggestions.plannedItemId,
            suggestions.subItem,
            suggestions.exerciseId,
          ],
          set: {
            sets: values.sets,
            repsMin: values.repsMin,
            repsMax: values.repsMax,
            rirMin: values.rirMin,
            rirMax: values.rirMax,
            rirMid: values.rirMid,
            loadKg: values.loadKg,
            addedKg: values.addedKg,
            assistKg: values.assistKg,
            band: values.band,
            systemLoad: values.systemLoad,
            e1rmUsed: values.e1rmUsed,
            labels: values.labels,
            readinessLevel: values.readinessLevel,
            updatedAt: sql`now()`,
          },
          setWhere: sql`not exists (select 1 from ${logGroups} where ${logGroups.suggestionId} = ${suggestions.id})`,
        });
    }
    const existing = await tx.select().from(suggestions).where(eq(suggestions.sessionDate, date));
    const used = existing.length
      ? await tx
          .selectDistinct({ id: logGroups.suggestionId })
          .from(logGroups)
          .where(
            inArray(
              logGroups.suggestionId,
              existing.map((r) => r.id),
            ),
          )
      : [];
    const usedIds = new Set(used.map((u) => u.id as number));
    const stale = existing.filter(
      (r) =>
        !usedIds.has(r.id) && !wanted.has(suggestionKey(r.plannedItemId, r.subItem, r.exerciseId)),
    );
    if (stale.length) {
      await tx.delete(suggestions).where(
        inArray(
          suggestions.id,
          stale.map((r) => r.id),
        ),
      );
    }
    return { existing: existing.filter((r) => !stale.includes(r)), usedIds };
  });

  const ids = new Map<string, number>();
  const overlay = new Map<string, SuggestionRow>();
  for (const r of rows.existing) {
    const key = suggestionKey(r.plannedItemId, r.subItem, r.exerciseId);
    ids.set(key, r.id);
    if (rows.usedIds.has(r.id)) overlay.set(key, r);
  }

  const items: AdjustedItem[] = session.items.map((item) => {
    let changed = false;
    const sugs: AdjustedItem["suggestions"] = { ...item.suggestions };
    for (const exId of item.target.exerciseIds) {
      const row = overlay.get(suggestionKey(item.target.plannedItemId, item.target.subItem, exId));
      if (row) {
        sugs[exId] = suggestionFromRow(row);
        changed = true;
      }
    }
    if (!changed) return item;
    const first = item.target.exerciseIds[0];
    const sug =
      (first !== undefined ? sugs[first] : null) ?? Object.values(sugs).find(Boolean) ?? null;
    return {
      ...item,
      suggestions: sugs,
      suggestion: sug,
      prescription: sug ? prescriptionOf(sug) : item.prescription,
    };
  });

  return {
    input,
    session: { ...session, items },
    ids,
    frozenIds: rows.usedIds,
  };
}

// ---------------------------------------------------------------------------
// Readiness freeze (SPEC 5.6c)
// ---------------------------------------------------------------------------

export interface FreezeResult {
  level: ReadinessLevel;
  counted: ReadinessSignal[];
  /** A derived row exists for the date (false only for an early /today preview). */
  frozen: boolean;
  /** This call wrote or rewrote the derived row. */
  written: boolean;
}

export interface FreezeOptions {
  /** `first_log` (default): freeze now. `today`: /today only freezes from 05:00 Rome, earlier it just previews. */
  trigger?: "first_log" | "today";
  /** A /readiness tap: recompute and rewrite the row, allowed only until the first log of the day. */
  refreeze?: boolean;
}

const TODAY_FREEZE_HOUR = 5;

/**
 * Compute the readiness level once per date and store it as a `derived` readiness_logs row. Later calls return the
 * stored level; with `refreeze` the row is recomputed as long as no log group exists for the date. Drift recorded
 * during a session never reaches the same session (drift only comes from sessions before `date`).
 */
export async function freezeReadiness(
  db: Db,
  date: string,
  now: Date,
  opts: FreezeOptions = {},
): Promise<FreezeResult> {
  const env = await loadPlanEnv(db);
  const asOf = now.toISOString();
  const early =
    opts.trigger === "today" &&
    DateTime.fromJSDate(now, { zone: APP_TIMEZONE }).hour < TODAY_FREEZE_HOUR;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`readiness:${date}`}))`);
    const [existing] = await tx
      .select()
      .from(readinessLogs)
      .where(and(eq(readinessLogs.date, date), eq(readinessLogs.source, "derived")))
      .limit(1);
    const [logged] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(logGroups)
      .where(eq(logGroups.sessionDate, date));
    const hasLogs = (logged?.n ?? 0) > 0;

    if (existing && !(opts.refreeze && !hasLogs)) {
      return {
        level: existing.level as ReadinessLevel,
        counted: [],
        frozen: true,
        written: false,
      };
    }

    const signals = env ? await loadReadinessSignals(tx, env, date) : [];
    const r = readinessLevel(signals, asOf);
    if (early && !existing)
      return { level: r.level, counted: r.counted, frozen: false, written: false };

    const note = JSON.stringify(r.counted.map((c) => c.kind));
    if (existing) {
      await tx
        .update(readinessLogs)
        .set({ at: now, level: r.level, note })
        .where(eq(readinessLogs.id, existing.id));
    } else {
      await tx.insert(readinessLogs).values({
        date,
        at: now,
        kind: DERIVED_KIND,
        source: "derived",
        level: r.level,
        note,
      });
    }
    return { level: r.level, counted: r.counted, frozen: true, written: true };
  });
}

export { loadFrozenLevel };

// ---------------------------------------------------------------------------
// Derived-state cache (SPEC 5.2)
// ---------------------------------------------------------------------------

export interface UserStateSnapshot {
  pullupGateOpen: boolean;
  pullupGateSince: string | null;
  lastBwMax: number | null;
  hspuStepOrder: number | null;
  hspuPadHeight: number | null;
}

/**
 * Recompute the pull-up gate and the HSPU step/pad from the full history and write the single `user_state` row.
 * Call it inside the transaction of every undo, edit, import and re-import.
 */
export async function refreshUserState(tx: Q): Promise<UserStateSnapshot> {
  const env = await loadPlanEnv(tx);
  let gate = { open: false, since: null as string | null, lastBwMax: null as number | null };
  let hspuRecs: SessionRec[] = [];
  let stepOrder: number | null = null;
  let pad: number | null = null;

  if (env) {
    const pullup = await loadPullupExercise(tx);
    if (pullup) gate = gateState(await loadGateEvents(tx, env, pullup, null));

    const ladderEx = await tx
      .select({ id: exercises.id })
      .from(exercises)
      .where(eq(exercises.type, "skill_ladder"));
    const ids = ladderEx.map((e) => e.id);
    if (ids.length) {
      const infos = await loadExerciseInfos(tx, ids);
      const recs = await loadSessionRecs(tx, env, infos, ids, null);
      hspuRecs = [...recs.values()].flat();
    }
    const state = hspuState(hspuRecs);
    stepOrder = state.stepOrder;
    pad = state.padHeight;
  }

  let stepId: number | null = null;
  if (stepOrder != null) {
    const [step] = await tx
      .select({ id: hspuLadder.id })
      .from(hspuLadder)
      .where(eq(hspuLadder.stepOrder, stepOrder));
    stepId = step?.id ?? null;
  }

  const values = {
    pullupGateOpen: gate.open,
    pullupGateSince: gate.since,
    lastBwMax: gate.lastBwMax,
    hspuStepId: stepId,
    hspuPadHeight: pad,
    updatedAt: new Date(),
  };
  await tx
    .insert(userState)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: userState.id, set: values });

  return {
    pullupGateOpen: gate.open,
    pullupGateSince: gate.since,
    lastBwMax: gate.lastBwMax,
    hspuStepOrder: stepOrder,
    hspuPadHeight: pad,
  };
}
