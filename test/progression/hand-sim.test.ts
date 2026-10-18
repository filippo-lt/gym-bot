/**
 * Hand-simulation fixtures (SPEC 9): expected suggestions written by hand in
 * test/fixtures/progression/expected.json for 26 Oct, 30 Oct (heavy legs) and 23 Nov.
 * "TODO" entries stay it.todo until filled in. See that file's _readme for the accepted shapes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planSession } from "../../src/progression/engine.js";
import type { AdjustedSession, Suggestion } from "../../src/progression/types.js";
import {
  buildSessionInput,
  expectedSlots,
  HAND_SIM_DATES,
} from "../fixtures/progression/history.js";

type Range = number | [number, number];
type Expected =
  | "TODO"
  | "none"
  | { ask: "load" | "bodyweight" | "band"; labels?: string[] }
  | {
      sets: number;
      reps: Range;
      rir: Range;
      load_kg?: number;
      added_kg?: number;
      assist_kg?: number;
      band?: string;
      labels?: string[];
    };

const file = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/progression/expected.json"), "utf8"),
) as Record<string, Record<string, Expected>>;

const range = (r: Range): [number, number] => (Array.isArray(r) ? r : [r, r]);
const labelSet = (l: readonly string[] | undefined) => [...new Set(l ?? [])].sort();

/** Comparable view of an expected value. Labels are compared as a set (order is not specified). */
function fromExpected(e: Exclude<Expected, "TODO">) {
  if (e === "none") return null;
  if ("ask" in e) return e.labels ? { ask: e.ask, labels: labelSet(e.labels) } : { ask: e.ask };
  const out: Record<string, unknown> = { sets: e.sets, reps: range(e.reps), rir: range(e.rir) };
  if (e.load_kg !== undefined) out.load_kg = e.load_kg;
  if (e.added_kg !== undefined) out.added_kg = e.added_kg;
  if (e.assist_kg !== undefined) out.assist_kg = e.assist_kg;
  if (e.band !== undefined) out.band = e.band;
  out.labels = labelSet(e.labels);
  return out;
}

/** Comparable view of the engine's suggestion, only the fields the fixtures specify. */
function fromActual(s: Suggestion | null, expectedView: ReturnType<typeof fromExpected>) {
  if (s === null) return null;
  if (expectedView && "ask" in expectedView) {
    return "labels" in expectedView ? { ask: s.ask, labels: labelSet(s.labels) } : { ask: s.ask };
  }
  const out: Record<string, unknown> = {
    sets: s.sets,
    reps: [s.repsMin, s.repsMax],
    rir: [s.rirMin, s.rirMax],
  };
  if (s.loadKg !== undefined) out.load_kg = s.loadKg;
  if (s.addedKg !== undefined) out.added_kg = s.addedKg;
  if (s.assistKg !== undefined) out.assist_kg = s.assistKg;
  if (s.band !== undefined) out.band = s.band;
  out.labels = labelSet(s.labels);
  return out;
}

describe("hand-simulation fixtures", () => {
  it("expected.json has exactly the load-math items of the three dates", () => {
    for (const date of HAND_SIM_DATES) {
      const want = expectedSlots(date)
        .map((s) => s.key)
        .sort();
      const have = Object.keys(file[date] ?? {}).sort();
      expect(have, date).toEqual(want);
    }
  });

  for (const date of HAND_SIM_DATES) {
    describe(date, () => {
      let session: AdjustedSession | undefined;
      const run = () => {
        session ??= planSession(buildSessionInput(date));
        return session;
      };

      for (const slot of expectedSlots(date)) {
        const exp = file[date]?.[slot.key];
        const name = `${slot.key} (${slot.slug})`;
        if (exp === undefined || exp === "TODO") {
          it.todo(name);
          continue;
        }
        it(name, () => {
          const item = run().items.find((i) => i.target.plannedItemId === slot.plannedItemId);
          expect(item, `item ${slot.itemKey} missing from the engine result`).toBeDefined();
          const actual = item?.suggestions[slot.exerciseId] ?? null;
          const want = fromExpected(exp);
          expect(fromActual(actual, want)).toEqual(want);
        });
      }
    });
  }
});
