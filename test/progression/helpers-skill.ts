import type {
  HspuLadderStep,
  ItemTarget,
  SessionRec,
  SetRec,
} from "../../src/progression/types.js";

export function set(p: Partial<SetRec> = {}): SetRec {
  return {
    reps: null,
    loadKg: null,
    addedKg: null,
    assistKg: null,
    band: null,
    rir: null,
    rirPlus: false,
    clean: null,
    durationS: null,
    ...p,
  };
}

export function session(p: Partial<SessionRec> & { date: string }): SessionRec {
  return {
    exerciseId: 1,
    plannedItemIds: [1],
    source: "bot",
    bwKg: 80,
    week: 1,
    isDeload: false,
    isTest: false,
    readiness: "GREEN",
    perSetUnknown: false,
    hspuStepOrder: null,
    padHeight: null,
    suggestion: null,
    sets: [],
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
    repsMin: 3,
    repsMax: 5,
    rirMin: 1,
    rirMax: 2,
    modifiers: [],
    tags: [],
    priority: "PRIMARY" as ItemTarget["priority"],
    isDeload: false,
    isTest: false,
    hiit: null,
    fallback: {
      if_bw_max_gte: 4,
      // biome-ignore lint/suspicious/noThenProperty: FallbackPrescription contract field
      then: { mode: "bodyweight", sets: 4, reps_min: 4, reps_max: 6 },
      else: { mode: "assisted", sets: 4, reps_min: 6, reps_max: 6 },
    },
    hspuStepOrder: null,
    order: 0,
    planName: "item",
    ...p,
  };
}

export const LADDER: HspuLadderStep[] = [
  {
    id: 1,
    stepOrder: 1,
    slug: "pike_push_up",
    name: "Pike push-up",
    defaultSets: 4,
    defaultRepsMin: 6,
    defaultRepsMax: 8,
    tempo: null,
  },
  {
    id: 2,
    stepOrder: 2,
    slug: "feet_elevated_pike",
    name: "Feet-elevated pike push-up",
    defaultSets: 4,
    defaultRepsMin: 6,
    defaultRepsMax: 8,
    tempo: null,
  },
  {
    id: 3,
    stepOrder: 3,
    slug: "hspu_negative",
    name: "HSPU negative",
    defaultSets: 3,
    defaultRepsMin: 3,
    defaultRepsMax: 3,
    tempo: "5s down",
  },
  {
    id: 4,
    stepOrder: 4,
    slug: "partial_rom_wall_hspu",
    name: "Partial-ROM wall HSPU",
    defaultSets: 4,
    defaultRepsMin: 3,
    defaultRepsMax: 4,
    tempo: null,
  },
  {
    id: 5,
    stepOrder: 5,
    slug: "lower_pad_wall_hspu",
    name: "Lower-pad wall HSPU",
    defaultSets: 4,
    defaultRepsMin: 3,
    defaultRepsMax: 3,
    tempo: null,
  },
  {
    id: 6,
    stepOrder: 6,
    slug: "full_wall_hspu",
    name: "Full wall HSPU",
    defaultSets: 5,
    defaultRepsMin: 2,
    defaultRepsMax: 4,
    tempo: null,
  },
];
