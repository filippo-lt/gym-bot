import { roundTowardEasier } from "./rounding.js";
import type { ExerciseInfo, Suggestion } from "./types.js";

const DAY_MS = 86_400_000;
const BREAK_DAYS = 10;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Break rule (SPEC 5.2): item scheduled and not logged 2+ times in a row (occurrences oldest->newest, deload weeks
 * already excluded by the caller; an explicit skip counts as not logged; an OR occurrence is logged if any option was),
 * OR no training at all for 10+ days (class days count as training) before `asOf`.
 * `isDeload` (the session's own week) never triggers a break.
 */
export function breakApplies(input: {
  occurrences: { date: string; logged: boolean }[];
  lastTrainingDate: string | null;
  asOf: string;
  isDeload?: boolean;
}): boolean {
  if (input.isDeload) return false;
  const past = input.occurrences
    .filter((o) => o.date < input.asOf)
    .sort((a, b) => a.date.localeCompare(b.date));
  const [prev, last] = past.slice(-2);
  if (prev && last && !prev.logged && !last.logged) return true;
  if (
    input.lastTrainingDate != null &&
    daysBetween(input.lastTrainingDate, input.asOf) >= BREAK_DAYS
  )
    return true;
  return false;
}

/**
 * -10% of total system load, labelled `back_after_break`. bodyweight_plus: the cut (10% of system load) comes off
 * added weight only, floored at 0 (assistance untouched), then rounded toward easier. Suggestions with no load
 * (ask) only get the label.
 */
export function applyBreak(s: Suggestion, ex: ExerciseInfo, bwKg: number | null): Suggestion {
  const labels = s.labels.includes("back_after_break")
    ? s.labels
    : [...s.labels, "back_after_break" as const];
  const out: Suggestion = { ...s, labels };

  if (ex.loadBasis === "bodyweight_plus" || ex.type === "bodyweight_plus") {
    if (s.addedKg === undefined && s.assistKg === undefined) return out;
    const added = s.addedKg ?? 0;
    const assist = s.assistKg ?? 0;
    const system = s.systemLoad ?? (bwKg != null ? bwKg + added - assist : null);
    if (system == null) return out;
    const newAdded =
      roundTowardEasier({ addedKg: Math.max(0, added - 0.1 * system) }, ex).addedKg ?? 0;
    out.addedKg = newAdded;
    if (bwKg != null) out.systemLoad = bwKg + newAdded - assist;
    else delete out.systemLoad;
    return out;
  }

  if (s.loadKg === undefined) return out;
  const loadKg = roundTowardEasier({ loadKg: s.loadKg * 0.9 }, ex).loadKg ?? s.loadKg * 0.9;
  out.loadKg = loadKg;
  out.systemLoad = loadKg;
  return out;
}
