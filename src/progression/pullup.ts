import type {
  ExerciseInfo,
  GateEvent,
  GateState,
  ItemTarget,
  Label,
  PullupPlan,
  SessionRec,
  SetRec,
} from "./types.js";

const OPEN_AT = 6;
const CLOSE_IMPLIED_BELOW = 5;
const DEFAULT_BW_MAX_GTE = 4;

/** Epley with RIR: e1RM = system * (1 + (reps + RIR) / 30). Private on purpose (e1rm.ts is built in parallel). */
function epley(system: number, reps: number, rir: number): number {
  return system * (1 + (reps + rir) / 30);
}

/** Replay events in date order (SPEC 5.2): open on clean BW >= 6 / test max >= 6; close on test max < 6 or implied < 5 twice in a row. */
export function gateState(events: GateEvent[]): GateState {
  const ordered = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map((x) => x.e);

  let open = false;
  let since: string | null = null;
  let lowStreak = 0;
  let lastMaxDate: string | null = null;
  let lastMax: number | null = null;

  const noteMax = (date: string, reps: number) => {
    if (lastMaxDate === date && lastMax !== null) lastMax = Math.max(lastMax, reps);
    else {
      lastMaxDate = date;
      lastMax = reps;
    }
  };

  for (const ev of ordered) {
    if (ev.kind === "session_implied") {
      if (ev.reps < CLOSE_IMPLIED_BELOW) {
        lowStreak += 1;
        if (open && lowStreak >= 2) {
          open = false;
          lowStreak = 0;
        }
      } else {
        lowStreak = 0;
      }
      continue;
    }
    // A working set is a "max" only when near-max (RIR <= 1 logged) or >= 6 reps; test maxes always count.
    if (ev.kind === "test_max" || ev.reps >= OPEN_AT || (ev.rir != null && ev.rir <= 1))
      noteMax(ev.date, ev.reps);
    if (ev.reps >= OPEN_AT) {
      if (!open) {
        open = true;
        since = ev.date;
      }
      lowStreak = 0;
    } else if (ev.kind === "test_max") {
      open = false;
      lowStreak = 0;
    }
  }

  return { open, since: open ? since : null, lastBwMax: lastMax };
}

function isCleanBw(s: SetRec): boolean {
  return (
    s.clean === true &&
    s.reps !== null &&
    s.band === null &&
    (s.addedKg ?? 0) === 0 &&
    (s.assistKg ?? 0) === 0
  );
}

/** A set that can feed the session e1RM (valid-set rules, pull-up part). */
function validSystemLoad(s: SetRec, bw: number): number | null {
  if (s.reps === null || s.reps > 15 || s.rir === null || s.clean === false) return null;
  if (s.band !== null && s.assistKg === null) return null; // unmapped band
  const system = bw + (s.addedKg ?? 0) - (s.assistKg ?? 0);
  return system > 0 ? system : null;
}

/**
 * Build gate events from pull-up sessions (oldest or newest first, any order) and metrics (check-in/test maxes).
 * implied reps = 30 * (e1RM / bw - 1) - 1.5 from each session's own estimate.
 */
export function gateEventsFrom(
  sessions: SessionRec[],
  metrics: { date: string; maxCleanReps: number }[],
  _ex?: ExerciseInfo,
): GateEvent[] {
  const events: GateEvent[] = [];
  for (const s of sessions) {
    for (const set of s.sets) {
      if (isCleanBw(set)) {
        events.push({
          kind: "clean_bw_set",
          date: s.date,
          reps: set.reps as number,
          rir: set.rir,
        });
      }
    }
    // Session estimate: deload, test, RED, unknown-split imports and missing bw are not valid.
    if (s.isDeload || s.isTest || s.readiness === "RED" || s.perSetUnknown) continue;
    if (s.bwKg === null || s.bwKg <= 0) continue;
    let best: number | null = null;
    for (const set of s.sets) {
      const system = validSystemLoad(set, s.bwKg);
      if (system === null) continue;
      const e = epley(system, set.reps as number, set.rir as number);
      if (best === null || e > best) best = e;
    }
    if (best !== null) {
      events.push({
        kind: "session_implied",
        date: s.date,
        reps: 30 * (best / s.bwKg - 1) - 1.5,
      });
    }
  }
  for (const m of metrics) {
    events.push({ kind: "test_max", date: m.date, reps: m.maxCleanReps });
  }
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map((x) => x.e);
}

/** Skill work is never below RIR 1 outside tests (SPEC 5.2). */
export function pullupRirMin(target: ItemTarget): number {
  const min = target.rirMin ?? 1;
  return target.isTest ? min : Math.max(1, min);
}

/**
 * Closed gate -> fallback (BW 4 x 4-6 if lastBwMax >= 4 else assisted 4 x 6); max test first when gate not open and no max.
 * Open gate -> "weighted": the engine computes the load, sets x reps come from the plan item.
 * Test items: no load math; sets x reps from the item, mode from the gate, never a max-test-first.
 */
export function pullupPlan(
  gate: GateState,
  target: ItemTarget,
  lastBwMax: number | null,
): PullupPlan {
  const planSets = target.setsMax ?? target.setsMin ?? 4;
  const planMin = target.repsMin ?? 4;
  const planMax = target.repsMax ?? planMin;

  if (gate.open) {
    return {
      mode: "weighted",
      maxTestFirst: false,
      sets: planSets,
      repsMin: planMin,
      repsMax: planMax,
      labels: [],
    };
  }

  const fb = target.fallback;
  const threshold = fb?.if_bw_max_gte ?? DEFAULT_BW_MAX_GTE;
  const useBw = lastBwMax !== null && lastBwMax >= threshold;
  const bw = fb?.then ?? { sets: 4, reps_min: 4, reps_max: 6 };
  const assisted = fb?.else ?? { sets: 4, reps_min: 6, reps_max: 6 };
  const pick = useBw ? bw : assisted;
  const labels: Label[] = [useBw ? "fallback_bw" : "fallback_assisted"];

  if (target.isTest) {
    return {
      mode: useBw ? "fallback_bw" : "fallback_assisted",
      maxTestFirst: false,
      sets: planSets,
      repsMin: planMin,
      repsMax: planMax,
      labels: [],
    };
  }

  const maxTestFirst = lastBwMax === null;
  if (maxTestFirst) labels.push("max_test_first");
  return {
    mode: useBw ? "fallback_bw" : "fallback_assisted",
    maxTestFirst,
    sets: pick.sets,
    repsMin: pick.reps_min,
    repsMax: pick.reps_max,
    labels,
  };
}
