import type { ExerciseInfo, SessionRec, SetRec } from "./types.js";

const MAX_REPS = 15;

function isLoadMath(ex: ExerciseInfo): boolean {
  return ex.type === "weighted" || ex.type === "bodyweight_plus";
}

function isBodyweightPlus(ex: ExerciseInfo): boolean {
  return ex.loadBasis === "bodyweight_plus" || ex.type === "bodyweight_plus";
}

/** Epley with RIR: systemLoad * (1 + (reps + rir) / 30) (SPEC 5.2). */
export function setE1rm(systemLoad: number, reps: number, rir: number): number {
  return systemLoad * (1 + (reps + rir) / 30);
}

/**
 * System load of a set: weighted -> loadKg; bodyweight_plus -> bw + added - assist (null if bw missing or band unmapped).
 * A band, when set, decides the assistance (its kg from equipment.bands) over any stored assistKg.
 */
export function systemLoadOf(set: SetRec, ex: ExerciseInfo, bwKg: number | null): number | null {
  if (!isBodyweightPlus(ex)) return set.loadKg;
  if (bwKg == null) return null;
  let assist = set.assistKg ?? 0;
  if (set.band != null) {
    const mapped = ex.equipment?.bands[set.band];
    if (mapped === undefined) return null;
    assist = mapped;
  }
  return bwKg + (set.addedKg ?? 0) - assist;
}

interface UsableSet {
  set: SetRec;
  load: number;
}

function usableSets(s: SessionRec, ex: ExerciseInfo): UsableSet[] {
  if (!isLoadMath(ex)) return [];
  if (s.isDeload || s.isTest || s.perSetUnknown || s.readiness === "RED") return [];
  const out: UsableSet[] = [];
  for (const set of s.sets) {
    if (set.rir == null || set.reps == null) continue;
    if (set.reps < 1 || set.reps > MAX_REPS) continue;
    if (set.clean === false) continue;
    const load = systemLoadOf(set, ex, s.bwKg);
    if (load == null || load <= 0) continue;
    out.push({ set, load });
  }
  return out;
}

/** Valid sets of a session (SPEC 5.2): RIR logged, reps <= 15, not deload/test/unclean/RED/perSetUnknown/unmapped band. */
export function validSets(s: SessionRec, ex: ExerciseInfo): SetRec[] {
  return usableSets(s, ex).map((u) => u.set);
}

/**
 * Best set estimate of a session. `strict` uses only non-"4+" sets; `withPlus` also includes "4+" sets (RIR 4):
 * final = max(strict, withPlus) over the sessions, so "4+" may raise but never lower.
 */
export function sessionEstimate(
  s: SessionRec,
  ex: ExerciseInfo,
): { strict: number | null; withPlus: number | null } {
  let strict: number | null = null;
  let withPlus: number | null = null;
  for (const { set, load } of usableSets(s, ex)) {
    const e = setE1rm(load, set.reps as number, set.rir as number);
    if (withPlus == null || e > withPlus) withPlus = e;
    if (!set.rirPlus && (strict == null || e > strict)) strict = e;
  }
  return { strict, withPlus };
}

type Basis = "median3" | "lower2" | "single";

/** Combine session estimates (newest first): median of last 3 / lower of 2 / single. */
function combine(estimates: number[]): { value: number; basis: Basis } | null {
  const last = estimates.slice(0, 3);
  if (last.length === 0) return null;
  if (last.length === 1) return { value: last[0] as number, basis: "single" };
  if (last.length === 2) return { value: Math.min(...last), basis: "lower2" };
  const sorted = [...last].sort((a, b) => a - b);
  return { value: sorted[1] as number, basis: "median3" };
}

/**
 * Current e1RM from sessions (newest first): median of last 3 valid sessions / lower of 2 / single.
 * `botSessions` = bot-logged sessions with at least one valid set; `importedOnly` while fewer than 2.
 * Null when no valid session or the exercise has no load math.
 */
export function currentE1rm(
  sessions: SessionRec[],
  ex: ExerciseInfo,
): {
  value: number;
  basis: Basis;
  botSessions: number;
  importedOnly: boolean;
} | null {
  if (!isLoadMath(ex)) return null;
  const strictList: number[] = [];
  const plusList: number[] = [];
  let botSessions = 0;
  for (const s of sessions) {
    const est = sessionEstimate(s, ex);
    if (est.strict != null) strictList.push(est.strict);
    if (est.withPlus != null) {
      plusList.push(est.withPlus);
      if (s.source === "bot") botSessions++;
    }
  }
  const a = combine(strictList);
  const b = combine(plusList);
  const best = a && b ? (b.value > a.value ? b : a) : (a ?? b);
  if (!best) return null;
  return { ...best, botSessions, importedOnly: botSessions < 2 };
}
