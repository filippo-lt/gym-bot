import type {
  EquipmentRec,
  ExerciseInfo,
  ItemTarget,
  SessionRec,
  SetRec,
} from "../../src/progression/types.js";

export function equip(p: Partial<EquipmentRec> = {}): EquipmentRec {
  return { slug: "eq", baseKg: null, stepKg: null, discreteValues: null, bands: {}, ...p };
}

export function barbell(id = 1, p: Partial<EquipmentRec> = {}): ExerciseInfo {
  return {
    id,
    slug: `barbell-${id}`,
    type: "weighted",
    loadBasis: "barbell_total",
    isMainLift: true,
    equipment: equip({ baseKg: 20, stepKg: 2.5, ...p }),
  };
}

export function dumbbell(id = 2, p: Partial<EquipmentRec> = {}): ExerciseInfo {
  return {
    id,
    slug: `db-${id}`,
    type: "weighted",
    loadBasis: "per_hand",
    isMainLift: false,
    equipment: equip({ discreteValues: [8, 10, 12, 14, 16, 18, 20], ...p }),
  };
}

export function stack(id = 3, p: Partial<EquipmentRec> = {}): ExerciseInfo {
  return {
    id,
    slug: `stack-${id}`,
    type: "weighted",
    loadBasis: "stack",
    isMainLift: false,
    equipment: equip({ stepKg: 5, ...p }),
  };
}

export function pullup(id = 4, p: Partial<EquipmentRec> = {}): ExerciseInfo {
  return {
    id,
    slug: "pullup",
    type: "bodyweight_plus",
    loadBasis: "bodyweight_plus",
    isMainLift: true,
    equipment: equip({ stepKg: 1.25, bands: { red: 10, black: 20, purple: 30 }, ...p }),
  };
}

export function set(p: Partial<SetRec> = {}): SetRec {
  return {
    reps: 5,
    loadKg: 100,
    addedKg: null,
    assistKg: null,
    band: null,
    rir: 2,
    rirPlus: false,
    clean: null,
    durationS: null,
    ...p,
  };
}

export function session(exerciseId: number, p: Partial<SessionRec> = {}): SessionRec {
  return {
    date: "2026-10-05",
    exerciseId,
    plannedItemIds: [1],
    source: "bot",
    bwKg: 80,
    week: 2,
    isDeload: false,
    isTest: false,
    readiness: "GREEN",
    perSetUnknown: false,
    hspuStepOrder: null,
    padHeight: null,
    suggestion: null,
    sets: [set()],
    ...p,
  };
}

export function target(p: Partial<ItemTarget> = {}): ItemTarget {
  return {
    plannedItemId: 1,
    subItem: 0,
    exerciseIds: [1],
    setsMin: 4,
    setsMax: 4,
    repsMin: 5,
    repsMax: 5,
    rirMin: 1,
    rirMax: 2,
    modifiers: [],
    tags: [],
    priority: "High",
    isDeload: false,
    isTest: false,
    hiit: null,
    fallback: null,
    hspuStepOrder: null,
    order: 0,
    planName: "x",
    ...p,
  } as ItemTarget;
}
