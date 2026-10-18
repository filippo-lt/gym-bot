/** Pure unit math (SPEC 5.2). Every number the user sees is computed here, never by the model. */
import type { ExerciseType, LoadBasis } from "../plan-import/types.js";
import type { EquipmentInfo, LogSetsInput, ResolvedEntry, SetInput } from "./types.js";

export interface UnitExercise {
  type: ExerciseType;
  loadBasis: LoadBasis | null;
  equipment: EquipmentInfo | null;
}

export interface GroupDefaults {
  rir?: number | "4+";
  clean?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "Red band" / " RED " -> "red": the key used in equipment.bands. Letters, digits, space, dash only. */
export function normalizeBand(colour: string): string {
  return colour
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+band$/, "")
    .trim();
}

/**
 * Assistance kg of a stored set. A band decides it through the equipment's colour map at read time (the engine reads it
 * the same way, so a remap changes both); an unmapped colour has none. Without a band the stored value stands.
 */
export function bandAssist(
  band: string | null,
  stored: number | null,
  bands: Record<string, number> | undefined,
): number | null {
  return band == null ? stored : (bands?.[band] ?? null);
}

/** Uniform block {count, ...} becomes `count` copies. */
export function expandSets(sets: LogSetsInput["sets"]): SetInput[] {
  if (Array.isArray(sets)) return sets;
  const { count, ...rest } = sets;
  return Array.from({ length: count }, () => ({ ...rest }));
}

/** The load in the exercise's convention, from whatever form the user used. */
export function convertLoad(
  exercise: Pick<UnitExercise, "loadBasis" | "equipment">,
  set: Pick<SetInput, "load_kg" | "plates_per_side_kg" | "pair_total_kg">,
): number | null {
  if (set.load_kg !== undefined) return set.load_kg;
  if (exercise.loadBasis === "barbell_total" && set.plates_per_side_kg !== undefined) {
    const base = exercise.equipment?.baseKg;
    return base == null ? null : round2(base + 2 * set.plates_per_side_kg);
  }
  if (exercise.loadBasis === "per_hand" && set.pair_total_kg !== undefined) {
    return round2(set.pair_total_kg / 2);
  }
  return null;
}

export function toEntry(
  exercise: UnitExercise,
  set: SetInput,
  setIndex: number,
  group: GroupDefaults = {},
): ResolvedEntry {
  const isBw = exercise.type === "bodyweight_plus";
  let loadKg: number | null = null;
  let addedKg: number | null = null;
  let assistKg: number | null = null;
  let band: string | null = null;
  if (isBw) {
    band = set.band ? normalizeBand(set.band) || null : null;
    addedKg = set.added_kg ?? set.load_kg ?? 0;
    // A band decides the assistance through equipment.bands; unmapped = null (no load math, SPEC 5.2).
    const mapped = band ? exercise.equipment?.bands?.[band] : undefined;
    assistKg = set.assist_kg ?? (band ? (mapped ?? null) : 0);
  } else {
    loadKg = convertLoad(exercise, set);
  }
  return {
    setIndex,
    reps: set.reps ?? null,
    loadKg,
    addedKg,
    assistKg,
    durationS: set.duration_s ?? null,
    distanceM: set.distance_m ?? null,
    padHeight: set.pad_height ?? null,
    rir: set.rir ?? null,
    rirPlus: set.rir !== undefined ? (set.rir_plus ?? false) : false,
    clean: group.clean ?? null,
    note: null,
    band,
  };
}

/** Group RIR ("4+" = 4 with plus) goes on the last set, unless that set has its own. */
export function buildEntries(
  exercise: UnitExercise,
  sets: LogSetsInput["sets"],
  group: GroupDefaults = {},
): ResolvedEntry[] {
  const entries = expandSets(sets).map((s, i) => toEntry(exercise, s, i + 1, group));
  const last = entries[entries.length - 1];
  if (last && group.rir !== undefined && last.rir === null) {
    if (group.rir === "4+") {
      last.rir = 4;
      last.rirPlus = true;
    } else {
      last.rir = group.rir;
      last.rirPlus = false;
    }
  }
  return entries;
}

/** Load used for progression and the far-off check; null when it can't be computed. */
export function systemLoad(
  entry: Pick<ResolvedEntry, "loadKg" | "addedKg" | "assistKg"> & { band?: string | null },
  exercise: Pick<UnitExercise, "type">,
  bwKg: number | null,
): number | null {
  if (exercise.type === "weighted") return entry.loadKg;
  if (exercise.type === "bodyweight_plus") {
    if (bwKg === null) return null;
    // A band set whose colour has no kg mapping has no load math.
    if (entry.band != null && entry.assistKg == null) return null;
    return round2(bwKg + (entry.addedKg ?? 0) - (entry.assistKg ?? 0));
  }
  return null;
}

export function maxSystemLoad(
  entries: (Pick<ResolvedEntry, "loadKg" | "addedKg" | "assistKg"> & { band?: string | null })[],
  exercise: Pick<UnitExercise, "type">,
  bwKg: number | null,
): number | null {
  let max: number | null = null;
  for (const e of entries) {
    const v = systemLoad(e, exercise, bwKg);
    if (v !== null && (max === null || v > max)) max = v;
  }
  return max;
}

export function maxReps(entries: Pick<ResolvedEntry, "reps">[]): number | null {
  let max: number | null = null;
  for (const e of entries) if (e.reps !== null && (max === null || e.reps > max)) max = e.reps;
  return max;
}

/** Fields that decide whether a log can be saved without asking. */
export function missingFields(exercise: UnitExercise, entries: ResolvedEntry[]): string[] {
  const out: string[] = [];
  const t = exercise.type;
  if (
    (t === "weighted" ||
      t === "bodyweight_plus" ||
      t === "bodyweight_reps" ||
      t === "skill_ladder") &&
    entries.some((e) => e.reps === null)
  ) {
    out.push("reps");
  }
  if (t === "weighted" && entries.some((e) => e.loadKg === null)) out.push("load");
  if (t === "timed" && entries.some((e) => e.durationS === null)) out.push("duration");
  if (t === "distance" && entries.some((e) => e.distanceM === null)) out.push("distance");
  return out;
}
