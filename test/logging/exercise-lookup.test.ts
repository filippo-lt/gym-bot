import { describe, expect, it } from "vitest";
import type { CatalogExercise } from "../../src/logging/catalog.js";
import type { AliasRow } from "../../src/logging/memory.js";
import { resolveExerciseQuery } from "../../src/queries/exercise-lookup.js";

function ex(id: number, slug: string, name: string, aliases: string[] = []): CatalogExercise {
  return {
    id,
    slug,
    name,
    aliases,
    type: "weighted",
    loadBasis: "barbell_total",
    isMainLift: false,
    needsClean: false,
    equipment: null,
  };
}

const catalog = [
  ex(1, "squat", "Squat", ["back squat"]),
  ex(2, "hack_squat", "Hack squat"),
  ex(3, "bench_press", "Bench press", ["bench"]),
  ex(4, "overhead_press", "Overhead press", ["ohp"]),
  ex(5, "face_pull", "Face pull", ["face pulls"]),
  ex(6, "bulgarian_split_squat", "Bulgarian split squat"),
  ex(7, "dips", "Dips"),
  ex(8, "pull_up", "Pull-up"),
];
const aliases: AliasRow[] = [
  { id: 1, alias: "fp", exerciseId: 5, slug: "face_pull", name: "Face pull" },
];

const slugOf = (r: ReturnType<typeof resolveExerciseQuery>) =>
  r.kind === "ok"
    ? r.exercise.slug
    : r.kind === "ambiguous"
      ? r.candidates.map((c) => c.slug)
      : "unknown";

describe("resolveExerciseQuery", () => {
  it("exact names win over partial overlaps", () => {
    expect(slugOf(resolveExerciseQuery("squat", undefined, catalog, aliases))).toBe("squat");
    expect(slugOf(resolveExerciseQuery("hack squat", undefined, catalog, aliases))).toBe(
      "hack_squat",
    );
    expect(slugOf(resolveExerciseQuery("Hack  Squat", undefined, catalog, aliases))).toBe(
      "hack_squat",
    );
    expect(slugOf(resolveExerciseQuery("back squat", undefined, catalog, aliases))).toBe("squat");
    expect(slugOf(resolveExerciseQuery("hack_squat", undefined, catalog, aliases))).toBe(
      "hack_squat",
    );
  });

  it("user aliases and catalog aliases", () => {
    expect(slugOf(resolveExerciseQuery("fp", undefined, catalog, aliases))).toBe("face_pull");
    expect(slugOf(resolveExerciseQuery("ohp", undefined, catalog, aliases))).toBe("overhead_press");
  });

  it("a given slug is checked against the words", () => {
    expect(slugOf(resolveExerciseQuery("squat", "squat", catalog, aliases))).toBe("squat");
    // The words name another exercise exactly: they win over the slug.
    expect(slugOf(resolveExerciseQuery("hack squat", "squat", catalog, aliases))).toBe(
      "hack_squat",
    );
    // The slug does not fit the words at all: ask, slug first.
    const r = resolveExerciseQuery("dips", "bench_press", catalog, aliases);
    expect(slugOf(r)).toBe("dips");
  });

  it("an OR phrase gives its options", () => {
    expect(slugOf(resolveExerciseQuery("Squat / hack squat", undefined, catalog, aliases))).toEqual(
      ["squat", "hack_squat"],
    );
    expect(
      slugOf(resolveExerciseQuery("squat or hack squat", undefined, catalog, aliases)),
    ).toEqual(["squat", "hack_squat"]);
  });

  it("a unique fuzzy match is taken, a vague one asks (max 4), nonsense is unknown", () => {
    expect(slugOf(resolveExerciseQuery("bulgarian", undefined, catalog, aliases))).toBe(
      "bulgarian_split_squat",
    );
    const press = resolveExerciseQuery("press", undefined, catalog, aliases);
    expect(press.kind).toBe("ambiguous");
    if (press.kind === "ambiguous") {
      expect(press.candidates.map((c) => c.slug).sort()).toEqual(["bench_press", "overhead_press"]);
      expect(press.candidates.every((c) => typeof c.id === "number")).toBe(true);
    }
    expect(slugOf(resolveExerciseQuery("xyzzy", undefined, catalog, aliases))).toBe("unknown");
    expect(slugOf(resolveExerciseQuery("  ", undefined, catalog, aliases))).toBe("unknown");
    const many = resolveExerciseQuery("squat press pull dips", undefined, catalog, aliases);
    if (many.kind === "ambiguous") expect(many.candidates.length).toBeLessThanOrEqual(4);
  });
});
