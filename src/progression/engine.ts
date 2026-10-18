import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import { accessoryStep, applyStep } from "./accessory.js";
import { applyBreak, breakApplies } from "./break.js";
import { currentE1rm } from "./e1rm.js";
import { fridayAdjust } from "./friday.js";
import { hspuReps, hspuState, shouldProposeAdvance } from "./hspu.js";
import { suggestMainLoad } from "./load.js";
import { gateState, pullupPlan, pullupRirMin } from "./pullup.js";
import { applyReadiness, type ReadinessItemChange, readinessLevel } from "./readiness.js";
import { applyShort } from "./short.js";
import type {
  AdjustedItem,
  AdjustedSession,
  ExerciseInfo,
  FridayAdjustment,
  GateState,
  ItemTarget,
  Label,
  PullupPlan,
  ReadinessLevel,
  SessionInput,
  SessionRec,
  Suggestion,
} from "./types.js";

const DAY_MS = 86_400_000;
const BW_STALE_DAYS = 14;
const HOLD_MODIFIERS = new Set(["easy", "light", "deload"]);

export interface PlanOptions {
  /** ISO timestamp the readiness level is computed at when `frozenLevel` is null. Default: noon Rome of the date. */
  asOf?: string;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function isLoadMath(ex: ExerciseInfo): boolean {
  return ex.type === "weighted" || ex.type === "bodyweight_plus";
}

const isBodyweightPlus = (ex: ExerciseInfo) =>
  ex.type === "bodyweight_plus" || ex.loadBasis === "bodyweight_plus";

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)];
}

/** Target after Friday and readiness changes (sets, reps and RIR actually prescribed). */
function effectiveTarget(
  target: ItemTarget,
  fri: FridayAdjustment | undefined,
  ready: ReadinessItemChange | undefined,
): ItemTarget {
  if (fri?.kind === "reduce") {
    return {
      ...target,
      setsMin: 2,
      setsMax: 2,
      repsMin: fri.reps,
      repsMax: fri.reps,
      rirMin: 3,
      rirMax: 4,
    };
  }
  if (fri?.kind === "deload_reduce") {
    return {
      ...target,
      setsMin: 1,
      setsMax: 1,
      rirMin: target.rirMin ?? 3,
      rirMax: target.rirMax ?? 4,
    };
  }
  if (ready?.easy) {
    return {
      ...target,
      setsMin: ready.easy.sets,
      setsMax: ready.easy.sets,
      rirMin: ready.easy.rirMin,
      rirMax: ready.easy.rirMax,
    };
  }
  return target;
}

function rirRange(eff: ItemTarget, ex: ExerciseInfo, floor1: boolean): [number, number] {
  // SPEC 5.2 defaults when the plan item has no RIR: main lifts 1-2, other weighted 1-3.
  let lo = eff.rirMin ?? eff.rirMax ?? 1;
  let hi = eff.rirMax ?? eff.rirMin ?? (ex.isMainLift ? 2 : 3);
  if (floor1) {
    lo = pullupRirMin({ ...eff, rirMin: lo });
    hi = Math.max(hi, lo);
  }
  return [lo, hi];
}

interface Ctx {
  input: SessionInput;
  gate: GateState;
  bwKg: number | null;
  bwStale: boolean;
  /** Per planned item: break rule fires. */
  breakByItem: Map<number, boolean>;
}

function estimateLabel(e: { botSessions: number; importedOnly: boolean; basis: string }): Label[] {
  if (e.botSessions === 0) return ["estimate_check_first_set"];
  if (e.basis === "single" || e.importedOnly) return ["estimate"];
  return [];
}

/** Valid (non-deload, non-test) sessions of an accessory, newest first. */
function accessorySessions(hist: SessionRec[]): SessionRec[] {
  return hist.filter((s) => !s.isDeload && !s.isTest && !s.perSetUnknown && s.sets.length > 0);
}

function lastLoadOf(s: SessionRec): number | null {
  for (let i = s.sets.length - 1; i >= 0; i--) {
    const l = s.sets[i]?.loadKg;
    if (l != null) return l;
  }
  return null;
}

function askLoad(base: Omit<Suggestion, "labels">, extra: Label[] = []): Suggestion {
  return { ...base, labels: ["baseline_ask_load", ...extra], ask: "load" };
}

function planBase(eff: ItemTarget, rir: [number, number], rirMid: number) {
  const repsMin = eff.repsMin ?? eff.repsMax ?? 1;
  return {
    sets: eff.setsMin ?? eff.setsMax ?? 1,
    repsMin,
    repsMax: eff.repsMax ?? repsMin,
    rirMin: rir[0],
    rirMax: rir[1],
    rirMid,
  };
}

function suggestWeighted(
  ex: ExerciseInfo,
  eff: ItemTarget,
  ctx: Ctx,
  rirMid: number,
  hold: boolean,
): Suggestion {
  const hist = ctx.input.history[ex.id] ?? [];
  const rir = rirRange(eff, ex, false);
  const base = planBase(eff, rir, rirMid);
  const brk = ctx.breakByItem.get(eff.plannedItemId) ?? false;

  if (ex.isMainLift) {
    const e = currentE1rm(hist, ex);
    if (!e) return askLoad(base);
    let s: Suggestion = {
      ...suggestMainLoad(e.value, eff, ex, ctx.bwKg, rirMid),
      rirMin: rir[0],
      rirMax: rir[1],
      rirMid,
      labels: estimateLabel(e),
    };
    if (brk) s = applyBreak(s, ex, ctx.bwKg);
    return s;
  }

  const valid = accessorySessions(hist);
  const latest = valid[0];
  const last = latest ? lastLoadOf(latest) : null;
  if (!latest || last == null) return askLoad(base);
  const step = hold ? 0 : accessoryStep(valid, eff);
  const loadKg = applyStep(last, step, ex);
  const bot = valid.some((s) => s.source === "bot");
  let s: Suggestion = {
    ...base,
    loadKg,
    systemLoad: loadKg,
    labels: bot ? [] : ["estimate_check_first_set"],
  };
  if (brk && !hold) s = applyBreak(s, ex, ctx.bwKg);
  return s;
}

function suggestPullup(
  ex: ExerciseInfo,
  eff: ItemTarget,
  pp: PullupPlan,
  ctx: Ctx,
  rirMid: number,
): Suggestion | null {
  if (eff.isTest) return null;
  const hist = ctx.input.history[ex.id] ?? [];
  const rir = rirRange(eff, ex, true);
  const bw = ctx.bwKg;
  const sets = pp.sets;
  const reps = { repsMin: pp.repsMin, repsMax: pp.repsMax };
  const base = { sets, ...reps, rirMin: rir[0], rirMax: rir[1], rirMid };
  const staleLabel: Label[] = ctx.bwStale ? ["bw_stale"] : [];
  const brk = ctx.breakByItem.get(eff.plannedItemId) ?? false;

  if (pp.mode === "weighted") {
    const e = currentE1rm(hist, ex);
    if (!e) return askLoad(base, staleLabel);
    const itemForLoad: ItemTarget = {
      ...eff,
      setsMin: sets,
      setsMax: sets,
      repsMin: pp.repsMin,
      repsMax: pp.repsMax,
      rirMin: rir[0],
      rirMax: rir[1],
    };
    let s: Suggestion = {
      ...suggestMainLoad(e.value, itemForLoad, ex, bw, rirMid, { gateOpen: true }),
      rirMid,
    };
    s.labels = [...estimateLabel(e), ...staleLabel];
    if (brk && s.ask == null) s = applyBreak(s, ex, bw);
    return s;
  }

  if (pp.mode === "fallback_bw") {
    return {
      ...base,
      addedKg: 0,
      ...(bw != null ? { systemLoad: bw } : {}),
      ...(bw == null ? { ask: "bodyweight" as const } : {}),
      labels: [...pp.labels, ...staleLabel],
    };
  }

  // fallback_assisted: assistance from the e1RM when there is one, else ask.
  const e = currentE1rm(hist, ex);
  if (!e) return { ...base, labels: [...pp.labels, ...staleLabel], ask: "load" };
  const itemForLoad: ItemTarget = {
    ...eff,
    setsMin: sets,
    setsMax: sets,
    repsMin: pp.repsMin,
    repsMax: pp.repsMax,
    rirMin: rir[0],
    rirMax: rir[1],
  };
  const r = suggestMainLoad(e.value, itemForLoad, ex, bw, rirMid);
  const labels = [...pp.labels, ...estimateLabel(e), ...staleLabel];
  if (r.ask) return { ...r, rirMid, labels };
  if ((r.addedKg ?? 0) > 0) {
    // Gate closed: never add weight, fall back to plain bodyweight.
    return {
      ...base,
      addedKg: 0,
      ...(bw != null ? { systemLoad: bw } : {}),
      e1rmUsed: e.value,
      labels,
    };
  }
  return { ...r, rirMid, labels };
}

function romeNoon(date: string): string {
  return (
    DateTime.fromISO(`${date}T12:00:00`, { zone: APP_TIMEZONE }).toISO() ?? `${date}T12:00:00Z`
  );
}

/**
 * Pure orchestrator: test week -> Friday -> readiness -> suggestions + labels -> short filter.
 * No clock, no DB: everything arrives in `input`.
 */
export function planSession(input: SessionInput, opts: PlanOptions = {}): AdjustedSession {
  // Friday (needs Thursday's class; ask first when it is not reported).
  const askClassFirst = input.weekday === "fri" && !input.classReported;
  const friday =
    input.weekday === "fri" && input.classReported
      ? fridayAdjust(input.items, input.heavyGroups, input.isDeload)
      : new Map<number, FridayAdjustment>();

  // Readiness (frozen level when available).
  let level: ReadinessLevel;
  let levelSignals: AdjustedSession["levelSignals"] = [];
  if (input.frozenLevel) level = input.frozenLevel;
  else {
    const r = readinessLevel(input.readinessSignals, opts.asOf ?? romeNoon(input.date));
    level = r.level;
    levelSignals = r.counted;
  }
  const isMain = (item: ItemTarget) =>
    !item.isDeload &&
    !item.isTest &&
    !item.modifiers.some((m) => HOLD_MODIFIERS.has(m) || m === "test") &&
    item.exerciseIds.some((id) => input.exercises[id]?.isMainLift === true);
  const ready = applyReadiness(input.items, level, input.weekday, isMain);
  const shortMap = input.short
    ? applyShort(input.items)
    : new Map<number, { hidden?: boolean; optional?: boolean }>();

  const bw = input.bodyweight;
  const bwStale = bw == null || daysBetween(bw.date, input.date) > BW_STALE_DAYS;
  const gate = gateState(input.gateEvents);
  const ctx: Ctx = {
    input,
    gate,
    bwKg: bw?.kg ?? null,
    bwStale,
    breakByItem: new Map(),
  };

  let needsBodyweight = false;
  const items: AdjustedItem[] = [];

  for (const target of input.items) {
    const id = target.plannedItemId;
    const fri = friday.get(id);
    const rdy = ready.perItem.get(id);
    const sh = shortMap.get(id);
    const hidden = rdy?.hidden === true || fri?.kind === "skip" || sh?.hidden === true;
    const eff = effectiveTarget(target, fri, rdy);
    const options = target.exerciseIds
      .map((exId) => input.exercises[exId])
      .filter((e): e is ExerciseInfo => e !== undefined);
    const suggestions: Record<number, Suggestion | null> = {};
    for (const exId of target.exerciseIds) suggestions[exId] = null;

    const itemLabels: Label[] = [];
    if (fri?.kind === "reduce" || fri?.kind === "deload_reduce") itemLabels.push("friday_reduced");
    if (fri?.kind === "offer_skip" || fri?.kind === "skip") itemLabels.push("friday_offer_skip");
    if (rdy?.easy) itemLabels.push("readiness_red");
    else if (rdy?.rirMid !== undefined) itemLabels.push("readiness_yellow");

    // Break rule: per planned item, only for load-math items.
    if (options.some(isLoadMath) && !input.isTest) {
      const occ = input.occurrences.find((o) => o.plannedItemId === id)?.occurrences ?? [];
      ctx.breakByItem.set(
        id,
        breakApplies({
          occurrences: occ,
          lastTrainingDate: input.lastTrainingDate,
          asOf: input.date,
          isDeload: input.isDeload || target.isDeload,
        }),
      );
    }

    const friReduced = fri?.kind === "reduce" || fri?.kind === "deload_reduce";
    const hold =
      target.isDeload ||
      fri?.kind === "deload_reduce" ||
      target.modifiers.some((m) => HOLD_MODIFIERS.has(m));

    let pullup: PullupPlan | null = null;
    let hspu: AdjustedItem["hspu"] = null;
    let hspuAdvance: AdjustedItem["hspuAdvance"] = null;

    for (const ex of options) {
      if (isBodyweightPlus(ex)) {
        const lastBwMax = gate.lastBwMax;
        const pp = pullupPlan(gate, eff, lastBwMax);
        let plan = pp;
        if (rdy?.easy) plan = { ...plan, sets: Math.min(plan.sets, rdy.easy.sets) };
        if (pp.maxTestFirst) {
          const fb = eff.fallback;
          plan = {
            ...plan,
            afterMaxTest: {
              thresholdReps: fb?.if_bw_max_gte ?? 4,
              bw: {
                sets: fb?.then.sets ?? 4,
                repsMin: fb?.then.reps_min ?? 4,
                repsMax: fb?.then.reps_max ?? 6,
              },
              assisted: {
                sets: fb?.else.sets ?? 4,
                repsMin: fb?.else.reps_min ?? 6,
                repsMax: fb?.else.reps_max ?? 6,
              },
            },
          };
        }
        pullup ??= plan;
        if (hidden || input.isTest) continue;
        needsBodyweight ||= bwStale && !eff.isTest;
        const rir = rirRange(eff, ex, true);
        const rirMid = midFor(rdy, friReduced, rir, true);
        const s = suggestPullup(ex, eff, plan, ctx, rirMid);
        suggestions[ex.id] = s ? withLabels(s, itemLabels) : null;
      } else if (ex.type === "weighted") {
        if (hidden || input.isTest) continue;
        const rir = rirRange(eff, ex, false);
        const rirMid = midFor(rdy, friReduced, rir, false);
        const s = suggestWeighted(ex, eff, ctx, rirMid, hold && !ex.isMainLift);
        suggestions[ex.id] = withLabels(s, itemLabels);
      } else if (ex.type === "skill_ladder") {
        const hist = input.history[ex.id] ?? [];
        const state = hspuState(hist);
        const rir = rirRange(eff, ex, true);
        const hEff = { ...eff, rirMin: rir[0], rirMax: rir[1] };
        hspu ??= hspuReps(state, hEff, input.hspuLadder);
        if (rdy?.easy && hspu) hspu = { ...hspu, sets: Math.min(hspu.sets, rdy.easy.sets) };
        if (!input.isTest && !hidden) {
          hspuAdvance ??= shouldProposeAdvance(hist, state, hEff, input.hspuLadder);
        }
      }
    }

    const first = target.exerciseIds[0];
    const firstSug = first !== undefined ? (suggestions[first] ?? null) : null;
    const anySug = Object.values(suggestions).find((s) => s != null) ?? null;
    const sug = firstSug ?? anySug;
    const rirR = options[0] ? rirRange(eff, options[0], pullup != null || hspu != null) : null;
    const prescription = sug
      ? {
          sets: sug.sets,
          repsMin: sug.repsMin,
          repsMax: sug.repsMax,
          rirMin: sug.rirMin,
          rirMax: sug.rirMax,
        }
      : hspu
        ? {
            sets: hspu.sets,
            repsMin: hspu.repsMin,
            repsMax: hspu.repsMax,
            rirMin: rirR?.[0] ?? eff.rirMin,
            rirMax: rirR?.[1] ?? eff.rirMax,
          }
        : pullup && !pullup.maxTestFirst && (pullup.mode !== "weighted" || eff.isTest)
          ? {
              sets: pullup.sets,
              repsMin: pullup.repsMin,
              repsMax: pullup.repsMax,
              rirMin: rirR?.[0] ?? eff.rirMin,
              rirMax: rirR?.[1] ?? eff.rirMax,
            }
          : {
              sets: eff.setsMin ?? eff.setsMax,
              repsMin: eff.repsMin,
              repsMax: eff.repsMax,
              rirMin: eff.rirMin,
              rirMax: eff.rirMax,
            };

    items.push({
      target,
      suggestions,
      suggestion: sug,
      hidden,
      optional: sh?.optional === true || target.modifiers.includes("optional"),
      skipOffer:
        !hidden &&
        (fri?.kind === "offer_skip" || fri?.kind === "reduce" || fri?.kind === "deload_reduce"),
      friday: fri ?? null,
      prescription,
      hiit: hidden ? null : rdy && "hiit" in rdy ? (rdy.hiit ?? null) : target.hiit,
      pullup,
      hspu,
      hspuAdvance,
    });
  }

  return {
    date: input.date,
    level,
    levelSignals,
    items,
    restDaySuggested: ready.restDay,
    askClassFirst,
    isTest: input.isTest,
    needsBodyweight: needsBodyweight && !input.isTest,
    bodyweightDate: bw?.date ?? null,
    classAdvice: ready.classAdvice,
  };
}

function midFor(
  rdy: ReadinessItemChange | undefined,
  friReduced: boolean,
  rir: [number, number],
  floor1: boolean,
): number {
  if (!friReduced && !rdy?.easy && rdy?.rirMid !== undefined) {
    return floor1 ? Math.max(rdy.rirMid, rir[0]) : rdy.rirMid;
  }
  return (rir[0] + rir[1]) / 2;
}

function withLabels(s: Suggestion, extra: Label[]): Suggestion {
  return { ...s, labels: uniq([...s.labels, ...extra]) };
}
