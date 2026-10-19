import { describe, expect, it } from "vitest";
import { exerciseCaption, notEnoughText, volumeCaption } from "../../src/charts/caption";
import type { LoadPoint, RepsPoint } from "../../src/charts/series";
import type { ExerciseInfo } from "../../src/progression/types";

const info: ExerciseInfo = {
  id: 1,
  slug: "squat",
  type: "weighted",
  loadBasis: "barbell_total",
  isMainLift: true,
  equipment: null,
};
const pt = (date: string, e1rm: number | null): LoadPoint => ({
  date,
  week: 1,
  e1rm,
  flagged: false,
  estimate: false,
});

describe("exerciseCaption", () => {
  it("rounds and shows first -> last", () => {
    const r = exerciseCaption(
      "Squat",
      info,
      "load",
      [pt("2026-09-29", 85), pt("2026-10-06", 92.50000001)],
      [],
      "auto",
    );
    expect(r?.caption).toBe("Squat · e1RM 85 → 92.5 kg · 2 sessions since 29 Sep");
    expect(r?.facts).toMatchObject({
      first: 85,
      last: 92.5,
      sessions: 2,
      firstDate: "2026-09-29",
      lastDate: "2026-10-06",
    });
  });

  it("is null under two sessions with an e1RM point", () => {
    expect(
      exerciseCaption(
        "Squat",
        info,
        "load",
        [pt("2026-09-29", 85), pt("2026-10-06", null)],
        [],
        "auto",
      ),
    ).toBeNull();
  });

  it("escapes HTML in the name", () => {
    const r = exerciseCaption(
      "A<b>&",
      info,
      "load",
      [pt("2026-09-29", 85), pt("2026-10-06", 90)],
      [],
      "auto",
    );
    expect(r?.caption.startsWith("A&lt;b&gt;&amp; ·")).toBe(true);
  });

  it("names reps and the HSPU step", () => {
    const reps: RepsPoint[] = [
      {
        date: "2026-09-29",
        week: 1,
        bestSet: 3,
        seconds: null,
        step: "negatives",
        flagged: false,
        estimate: false,
      },
      {
        date: "2026-10-06",
        week: 2,
        bestSet: 5,
        seconds: null,
        step: "wall",
        flagged: false,
        estimate: false,
      },
    ];
    const r = exerciseCaption(
      "HSPU",
      { ...info, type: "skill_ladder", loadBasis: null },
      "hspu",
      [],
      reps,
      "auto",
    );
    expect(r?.caption).toContain("best set 3 → 5 reps");
    expect(r?.caption).toContain("wall");
  });
});

describe("year spans and escaping", () => {
  it("adds the year to the since date when the series spans years", () => {
    const r = exerciseCaption(
      "Squat",
      info,
      "load",
      [pt("2025-12-29", 85), pt("2026-01-06", 90)],
      [],
      "auto",
    );
    expect(r?.caption).toContain("since 29 Dec 2025");
  });

  it("escapes the name in the not-enough text", () => {
    expect(notEnoughText("A<b>", 1)).toBe("Not enough data to chart A&lt;b&gt; yet (1 session).");
  });
});

describe("notEnoughText", () => {
  it("pluralises", () => {
    expect(notEnoughText("Squat", 1)).toBe("Not enough data to chart Squat yet (1 session).");
    expect(notEnoughText("Squat", 2)).toBe("Not enough data to chart Squat yet (2 sessions).");
    expect(notEnoughText("Pull-up", 0, 1)).toBe(
      "Not enough data to chart Pull-up yet: 1 session logged, 0 with per-set data.",
    );
  });
});

describe("volumeCaption", () => {
  it("gives this week's sets", () => {
    expect(volumeCaption(12).caption).toBe("Weekly sets per muscle group · this week: 12 sets");
  });
});
