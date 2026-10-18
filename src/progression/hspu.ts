import type {
  HspuAdvanceProposal,
  HspuLadderStep,
  HspuReps,
  HspuState,
  ItemTarget,
  SessionRec,
} from "./types.js";

function newestFirst(sessions: SessionRec[]): SessionRec[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.date < b.s.date ? 1 : a.s.date > b.s.date ? -1 : a.i - b.i))
    .map((x) => x.s);
}

/** State from the last log (SPEC 5.2), bot or import. Pad height falls back to the latest reported one. */
export function hspuState(sessions: SessionRec[]): HspuState {
  const sorted = newestFirst(sessions);
  const last = sorted.find((s) => s.hspuStepOrder !== null);
  if (!last) return { stepOrder: null, padHeight: null };
  const pad = last.padHeight ?? sorted.find((s) => s.padHeight !== null)?.padHeight ?? null;
  return { stepOrder: last.hspuStepOrder, padHeight: pad };
}

/** Plan's sets x reps when the state step equals the plan's step; otherwise the state step's ladder defaults. */
export function hspuReps(state: HspuState, target: ItemTarget, ladder: HspuLadderStep[]): HspuReps {
  const step =
    state.stepOrder === null ? undefined : ladder.find((l) => l.stepOrder === state.stepOrder);
  const onPlan = !step || target.hspuStepOrder === null || target.hspuStepOrder === step.stepOrder;
  const planMin = target.repsMin ?? step?.defaultRepsMin ?? 0;
  if (onPlan) {
    return {
      sets: target.setsMax ?? target.setsMin ?? step?.defaultSets ?? 0,
      repsMin: planMin,
      repsMax: target.repsMax ?? planMin,
      tempo: step?.tempo ?? null,
      fromPlan: true,
    };
  }
  const min = step.defaultRepsMin ?? step.defaultRepsMax ?? 0;
  return {
    sets: step.defaultSets ?? 0,
    repsMin: min,
    repsMax: step.defaultRepsMax ?? min,
    tempo: step.tempo,
    fromPlan: false,
  };
}

/** Advance only after 2 clean non-deload sessions (all sets at reps_max) at the current step. `sessions` newest first. */
export function shouldProposeAdvance(
  sessions: SessionRec[],
  state: HspuState,
  target: ItemTarget,
  ladder?: HspuLadderStep[],
): HspuAdvanceProposal | null {
  if (state.stepOrder === null || target.isDeload) return null;
  const from = state.stepOrder;

  let to: number;
  if (ladder && ladder.length > 0) {
    const higher = ladder.map((l) => l.stepOrder).filter((o) => o > from);
    if (higher.length === 0) return null;
    to = Math.min(...higher);
  } else {
    to = from + 1;
  }

  const targetMax = ladder ? hspuReps(state, target, ladder).repsMax : (target.repsMax ?? 0);
  if (targetMax <= 0) return null;

  // Deload and test sessions neither count nor break the streak.
  const counted = newestFirst(sessions).filter(
    (s) => s.hspuStepOrder !== null && !s.isDeload && !s.isTest,
  );
  const lastTwo = counted.slice(0, 2);
  if (lastTwo.length < 2) return null;
  const ok = lastTwo.every(
    (s) =>
      s.hspuStepOrder === from &&
      !s.perSetUnknown &&
      s.sets.length > 0 &&
      s.sets.every((set) => set.clean === true && set.reps !== null && set.reps >= targetMax),
  );
  return ok ? { fromStepOrder: from, toStepOrder: to } : null;
}
