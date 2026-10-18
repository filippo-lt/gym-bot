import { describe, expect, it } from "vitest";
import { fuzzyScore, judgeGivenSlug, rankCandidates } from "../../src/logging/resolve.js";
import { CATALOG } from "../../src/plan-import/exercise-catalog.js";

const catalog = [
  { slug: "face_pull", name: "Face pull", aliases: [] },
  { slug: "front_squat", name: "Front squat", aliases: [] },
  { slug: "squat", name: "Squat", aliases: ["back squat"] },
  { slug: "hack_squat", name: "Hack squat", aliases: [] },
  { slug: "lateral_raise", name: "Lateral raise", aliases: ["side raise"] },
  { slug: "bench_press", name: "Bench press", aliases: [] },
  { slug: "pull_up", name: "Pull-up", aliases: ["chin up"] },
];
const slugs = (c: { slug: string }[]) => c.map((x) => x.slug);

describe("fuzzyScore", () => {
  it("scores exact over prefix over token overlap", () => {
    const exact = fuzzyScore("face pull", catalog[0] as (typeof catalog)[number]);
    const prefix = fuzzyScore("face pulls", catalog[0] as (typeof catalog)[number]);
    const none = fuzzyScore("bench", catalog[0] as (typeof catalog)[number]);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(0);
    expect(none).toBe(0);
  });
  it("matches initials", () => {
    expect(fuzzyScore("fp", catalog[0] as (typeof catalog)[number])).toBeGreaterThan(0);
    expect(fuzzyScore("fp", catalog[6] as (typeof catalog)[number])).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("lists today's exercises first in session order, then fuzzy matches", () => {
    const today = [
      { slug: "bench_press", name: "Bench press" },
      { slug: "lateral_raise", name: "Lateral raise" },
    ];
    const out = rankCandidates("squat", catalog, today);
    expect(slugs(out).slice(0, 2)).toEqual(["bench_press", "lateral_raise"]);
    expect(slugs(out).slice(2)).toContain("squat");
    expect(slugs(out)).toContain("hack_squat");
  });

  it("ranks the exact match first among fuzzy matches", () => {
    const out = rankCandidates("squat", catalog, []);
    expect(out[0]?.slug).toBe("squat");
  });

  it("caps at 6 and still shows fuzzy matches when today fills the list", () => {
    const today = Array.from({ length: 10 }, (_, i) => ({ slug: `x${i}`, name: `X${i}` }));
    const out = rankCandidates("face pull", catalog, today);
    expect(out).toHaveLength(6);
    expect(slugs(out)).toContain("face_pull");
    expect(slugs(out).slice(0, 3)).toEqual(["x0", "x1", "x2"]);
  });

  it("deduplicates today's options", () => {
    const today = [
      { slug: "squat", name: "Squat" },
      { slug: "squat", name: "Squat" },
    ];
    expect(slugs(rankCandidates("zzz", catalog, today))).toEqual(["squat"]);
  });
});

describe("judgeGivenSlug", () => {
  it.each([
    ["squats", "squat"],
    ["pullups", "pull_up"],
    ["pull ups", "pull_up"],
    ["face pulls", "face_pull"],
    ["lateral raises", "lateral_raise"],
    ["RDLs", "romanian_deadlift"],
    ["military press", "overhead_press"],
    ["hack squat", "hack_squat"],
  ])("accepts %s with slug %s without a question", (said, slug) => {
    const given = CATALOG.find((c) => c.slug === slug) as (typeof CATALOG)[number];
    expect(judgeGivenSlug(said, given, CATALOG)).toEqual({ kind: "ok", slug });
  });

  it("asks when the words don't fit the slug, slug first", () => {
    const squat = CATALOG.find((c) => c.slug === "squat") as (typeof CATALOG)[number];
    const r = judgeGivenSlug("fp", squat, CATALOG);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") {
      expect(r.candidates[0]?.slug).toBe("squat");
      expect(r.candidates.map((c) => c.slug)).toContain("face_pull");
    }
  });

  it("an active alias for the words wins over a mismatching slug", () => {
    const squat = CATALOG.find((c) => c.slug === "squat") as (typeof CATALOG)[number];
    expect(judgeGivenSlug("fp", squat, CATALOG, "face_pull")).toEqual({
      kind: "ok",
      slug: "face_pull",
    });
  });
});
