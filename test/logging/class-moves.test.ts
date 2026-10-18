import { describe, expect, it } from "vitest";
import { type ClassMove, classBreakdown } from "../../src/logging/class-moves.js";
import { logClassInputSchema } from "../../src/logging/types.js";

describe("classBreakdown", () => {
  it("counts each move in each group", () => {
    const moves: ClassMove[] = [
      { name: "Pistol", sets: 5, reps: 10, groups: ["legs"] },
      { name: "Pull-up", sets: 4, reps: 8, groups: ["pull"] },
      { name: "Burpee", groups: ["legs", "push"] },
    ];
    expect(classBreakdown(moves)).toEqual([
      { group: "pull", moves: 1, sets: 4 },
      { group: "push", moves: 1, sets: 1 },
      { group: "legs", moves: 2, sets: 6 },
    ]);
  });
});

describe("logClassInputSchema", () => {
  it("rejects an empty object, accepts moves only and heavy only", () => {
    expect(logClassInputSchema.safeParse({}).success).toBe(false);
    expect(
      logClassInputSchema.safeParse({ moves: [{ name: "Squat", groups: ["legs"] }] }).success,
    ).toBe(true);
    expect(logClassInputSchema.safeParse({ heavy_groups: ["legs"] }).success).toBe(true);
    expect(logClassInputSchema.safeParse({ heavy_groups: [] }).success).toBe(true);
  });
});
