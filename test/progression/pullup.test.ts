import { describe, expect, it } from "vitest";
import {
  gateEventsFrom,
  gateState,
  pullupPlan,
  pullupRirMin,
} from "../../src/progression/pullup.js";
import { session, set, target } from "./helpers-skill.js";

const bwSet = (reps: number, rir = 1) => set({ reps, rir, addedKg: 0, assistKg: 0, clean: true });
const weighted = (reps: number, added: number, rir = 1) =>
  set({ reps, rir, addedKg: added, assistKg: 0, clean: true });
const sysOf = (bw: number, added: number, assist: number) => bw + added - assist;

describe("pull-up system load", () => {
  it("is BW + added - assist (via the implied-reps estimate)", () => {
    // bw 80, +20, 5 reps @ RIR1 -> system 100, e1RM 120, implied 13.5
    const ev = gateEventsFrom([session({ date: "2026-10-05", sets: [weighted(5, 20)] })], []);
    const implied = ev.find((e) => e.kind === "session_implied");
    expect(sysOf(80, 20, 0)).toBe(100);
    expect(implied?.reps).toBeCloseTo(30 * ((100 * (1 + 6 / 30)) / 80 - 1) - 1.5, 6);
    // assisted: bw 80, -20 assist, 6 reps @ RIR1 -> system 60, e1RM 74 -> implied 30*(74/80-1)-1.5 < 0
    const ev2 = gateEventsFrom(
      [
        session({
          date: "2026-10-05",
          sets: [set({ reps: 6, rir: 1, addedKg: 0, assistKg: 20, clean: true })],
        }),
      ],
      [],
    );
    expect(ev2.find((e) => e.kind === "session_implied")?.reps).toBeCloseTo(
      30 * ((60 * (1 + 7 / 30)) / 80 - 1) - 1.5,
      6,
    );
  });
  it("assisted sets are not clean BW sets", () => {
    const ev = gateEventsFrom(
      [
        session({
          date: "2026-10-05",
          sets: [set({ reps: 8, rir: 1, assistKg: 10, addedKg: 0, clean: true })],
        }),
      ],
      [],
    );
    expect(ev.some((e) => e.kind === "clean_bw_set")).toBe(false);
  });
});

describe("gate state", () => {
  it("starts closed with no max", () => {
    expect(gateState([])).toEqual({ open: false, since: null, lastBwMax: null });
  });
  it("opens on 6 clean BW reps, not on 5", () => {
    expect(gateState([{ kind: "clean_bw_set", date: "2026-10-05", reps: 5 }]).open).toBe(false);
    const g = gateState([{ kind: "clean_bw_set", date: "2026-10-05", reps: 6 }]);
    expect(g).toEqual({ open: true, since: "2026-10-05", lastBwMax: 6 });
  });
  it("opens on a test/check-in max >= 6", () => {
    expect(gateState([{ kind: "test_max", date: "2026-10-09", reps: 7 }]).open).toBe(true);
  });
  it("stays open through weighted weeks and deloads (implied high, no BW sets)", () => {
    const sessions = [
      session({ date: "2026-10-05", sets: [bwSet(6)] }),
      session({ date: "2026-10-12", week: 2, sets: [weighted(5, 10)] }),
      session({ date: "2026-10-19", week: 3, isDeload: true, sets: [weighted(5, 0, 3)] }),
      session({ date: "2026-10-26", week: 4, sets: [weighted(4, 15)] }),
    ];
    const g = gateState(gateEventsFrom(sessions, []));
    expect(g.open).toBe(true);
    expect(g.since).toBe("2026-10-05");
  });
  it("closes on a later BW max test < 6", () => {
    const g = gateState([
      { kind: "clean_bw_set", date: "2026-10-05", reps: 7 },
      { kind: "test_max", date: "2026-12-14", reps: 5 },
    ]);
    expect(g).toEqual({ open: false, since: null, lastBwMax: 5 });
  });
  it("closes when implied < 5 in 2 sessions in a row; 1 alone does not", () => {
    const low = (date: string) => session({ date, sets: [bwSet(3)] }); // implied 2.5 (but 3 reps, no open)
    const open = { kind: "test_max", date: "2026-10-01", reps: 6 } as const;
    const one = gateState([open, ...gateEventsFrom([low("2026-10-05")], [])]);
    expect(one.open).toBe(true);
    const two = gateState([open, ...gateEventsFrom([low("2026-10-05"), low("2026-10-12")], [])]);
    expect(two.open).toBe(false);
  });
  it("a recovered session between two low ones resets the streak", () => {
    const events = [
      { kind: "test_max", date: "2026-10-01", reps: 6 },
      { kind: "session_implied", date: "2026-10-05", reps: 4 },
      { kind: "session_implied", date: "2026-10-12", reps: 8 },
      { kind: "session_implied", date: "2026-10-19", reps: 4 },
    ] as const;
    expect(gateState([...events]).open).toBe(true);
  });
  it("is order independent (sorted by date)", () => {
    const g = gateState([
      { kind: "test_max", date: "2026-12-14", reps: 5 },
      { kind: "clean_bw_set", date: "2026-10-05", reps: 7 },
    ]);
    expect(g.open).toBe(false);
  });
  it("lastBwMax is the max of the latest day", () => {
    const g = gateState([
      { kind: "clean_bw_set", date: "2026-10-05", reps: 7 },
      { kind: "clean_bw_set", date: "2026-10-12", reps: 3 },
      { kind: "clean_bw_set", date: "2026-10-12", reps: 4 },
    ]);
    expect(g.lastBwMax).toBe(4);
  });
});

describe("gateEventsFrom filters", () => {
  it("skips unclean sets, deload/test/RED sessions and missing bw for implied", () => {
    const sets = [set({ reps: 8, rir: 1, addedKg: 0, assistKg: 0, clean: false })];
    expect(gateEventsFrom([session({ date: "2026-10-05", sets })], [])).toEqual([]);
    const ok = [bwSet(5)];
    for (const p of [
      { isDeload: true },
      { isTest: true },
      { readiness: "RED" as const },
      { bwKg: null },
    ]) {
      const ev = gateEventsFrom([session({ date: "2026-10-05", sets: ok, ...p })], []);
      expect(ev.some((e) => e.kind === "session_implied")).toBe(false);
    }
  });
  it("uses each session's own estimate and orders by date", () => {
    const ev = gateEventsFrom(
      [
        session({ date: "2026-10-12", sets: [bwSet(4)] }),
        session({ date: "2026-10-05", sets: [bwSet(6)] }),
      ],
      [{ date: "2026-10-08", maxCleanReps: 7 }],
    );
    expect(ev.map((e) => e.date)).toEqual([...ev.map((e) => e.date)].sort());
    expect(ev.filter((e) => e.kind === "session_implied")).toHaveLength(2);
  });
});

describe("undo of the gate-opening set (pure replay)", () => {
  it("recompute without it closes the gate again", () => {
    const opener = session({ date: "2026-10-12", sets: [bwSet(6)] });
    const before = session({ date: "2026-10-05", sets: [bwSet(4)] });
    expect(gateState(gateEventsFrom([before, opener], [])).open).toBe(true);
    const undone = { ...opener, sets: [] };
    expect(gateState(gateEventsFrom([before, undone], [])).open).toBe(false);
  });
});

describe("pullupPlan", () => {
  const open = { open: true, since: "2026-10-05", lastBwMax: 6 };
  const closed = (lastBwMax: number | null) => ({ open: false, since: null, lastBwMax });
  it("open gate -> weighted, plan sets x reps", () => {
    const p = pullupPlan(open, target({ setsMax: 5, repsMin: 3, repsMax: 4 }), 6);
    expect(p).toMatchObject({
      mode: "weighted",
      maxTestFirst: false,
      sets: 5,
      repsMin: 3,
      repsMax: 4,
      labels: [],
    });
  });
  it("closed with BW max >= 4 -> bodyweight 4 x 4-6", () => {
    const p = pullupPlan(closed(4), target(), 4);
    expect(p).toMatchObject({
      mode: "fallback_bw",
      maxTestFirst: false,
      sets: 4,
      repsMin: 4,
      repsMax: 6,
    });
    expect(p.labels).toEqual(["fallback_bw"]);
  });
  it("closed with BW max < 4 -> assisted 4 x 6", () => {
    const p = pullupPlan(closed(3), target(), 3);
    expect(p).toMatchObject({
      mode: "fallback_assisted",
      maxTestFirst: false,
      sets: 4,
      repsMin: 6,
      repsMax: 6,
    });
    expect(p.labels).toEqual(["fallback_assisted"]);
  });
  it("closed and no max on record -> max test first, then fallback", () => {
    const p = pullupPlan(closed(null), target(), null);
    expect(p.maxTestFirst).toBe(true);
    expect(p.labels).toContain("max_test_first");
    expect(p.mode).toBe("fallback_assisted");
  });
  it("open gate never asks for a max test even with no max", () => {
    expect(
      pullupPlan({ open: true, since: "x", lastBwMax: null }, target(), null).maxTestFirst,
    ).toBe(false);
  });
  it("test item: no max-test-first, no fallback labels", () => {
    const p = pullupPlan(
      closed(null),
      target({ isTest: true, setsMax: 1, repsMin: 1, repsMax: 1 }),
      null,
    );
    expect(p).toMatchObject({ maxTestFirst: false, labels: [], sets: 1 });
  });
  it("uses defaults when the item has no fallback", () => {
    const p = pullupPlan(closed(5), target({ fallback: null }), 5);
    expect(p).toMatchObject({ mode: "fallback_bw", sets: 4, repsMin: 4, repsMax: 6 });
  });
});

describe("RIR floor", () => {
  it("never below 1 outside tests", () => {
    expect(pullupRirMin(target({ rirMin: 0 }))).toBe(1);
    expect(pullupRirMin(target({ rirMin: 0, isTest: true }))).toBe(0);
  });
});
