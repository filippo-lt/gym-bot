import type {
  EditLastInput,
  GroupSnapshot,
  LogSetsInput,
  ResolvedEntry,
  ResolvedExercise,
  ResolvedLog,
  StagedAction,
} from "../../src/logging/types.js";

export const squat: ResolvedExercise = {
  id: 1,
  slug: "squat",
  name: "Squat",
  type: "weighted",
  loadBasis: "barbell_total",
  isMainLift: true,
  needsClean: false,
  equipment: { slug: "barbell", baseKg: 15, stepKg: 2.5, discreteValues: null },
};

export const entry = (over: Partial<ResolvedEntry> = {}): ResolvedEntry => ({
  setIndex: 1,
  reps: 8,
  loadKg: 60,
  addedKg: null,
  assistKg: null,
  durationS: null,
  distanceM: null,
  padHeight: null,
  rir: null,
  rirPlus: false,
  clean: null,
  note: null,
  ...over,
});

export const logInput = (over: Partial<LogSetsInput> = {}): LogSetsInput => ({
  exercise: { slug: "squat", said: "squat" },
  sets: { count: 3, reps: 8, load_kg: 60 },
  guessed_fields: [],
  needs_confirmation: false,
  ...over,
});

export function resolved(over: Partial<ResolvedLog> = {}): ResolvedLog {
  return {
    said: "squat",
    exercise: squat,
    sessionDate: "2026-10-27",
    match: "today",
    plannedItem: null,
    hspuStep: null,
    entries: [entry({ setIndex: 1 }), entry({ setIndex: 2 }), entry({ setIndex: 3 })],
    bwKg: 70,
    note: null,
    missingFields: [],
    guessedFields: [],
    needsConfirmation: false,
    lastSession: { sessionDate: "2026-10-20", maxSystemLoad: 60, bestReps: 8 },
    ...over,
  };
}

export const logAction = (over: Partial<ResolvedLog> = {}): StagedAction => ({
  kind: "log_sets",
  input: logInput(),
  resolved: resolved(over),
});

export function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    groupId: 1,
    sessionDate: "2026-10-27",
    performedAt: "2026-10-27T10:00:00.000Z",
    exercise: { id: 1, slug: "squat", name: "Squat", type: "weighted", loadBasis: "barbell_total" },
    plannedItemId: null,
    hspuStep: null,
    bwKg: 70,
    entries: [entry({ setIndex: 1 }), entry({ setIndex: 2 })],
    ...over,
  };
}

export const editInput = (changes: EditLastInput["changes"] = {}): EditLastInput => ({
  changes,
  guessed_fields: [],
  needs_confirmation: false,
});
