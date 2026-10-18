import { describe, expect, it } from "vitest";
import {
  swapCardText,
  swapDaysQuestion,
  swapScopeQuestion,
} from "../../src/bot/plan-change-format.js";
import { resolvedSwap } from "../plan/helpers.js";

const TODAY = "2026-10-19";

describe("swap questions", () => {
  it("scope question names today when the reference is today", () => {
    const q = swapScopeQuestion(resolvedSwap(), 42, TODAY);
    expect(q.buttons).toEqual([
      ["Only today", "sw:42:t"],
      ["Rest of plan", "sw:42:r"],
    ]);
    expect(q.text).toContain("Face pull");
    expect(q.text).toContain("Band pull-apart");
  });
  it("scope question names the date otherwise", () => {
    const q = swapScopeQuestion(resolvedSwap({ referenceDate: "2026-10-23" }), 42, TODAY);
    expect(q.buttons[0]).toEqual(["Only Fri 23 Oct", "sw:42:t"]);
  });
  it("days question uses the weekday of the reference day", () => {
    const q = swapDaysQuestion(resolvedSwap({ scope: "rest" }), 7);
    expect(q.buttons).toEqual([
      ["Only Mondays", "sw:7:d"],
      ["Every day", "sw:7:a"],
    ]);
    expect(q.text).toContain("Mon and Fri");
  });
});

describe("swapCardText", () => {
  it("only today", () => {
    expect(swapCardText(resolvedSwap({ scope: "today" }), TODAY)).toBe(
      "Swap for today (Mon 19 Oct): Face pull → Band pull-apart (3 × 15, same tags). Nothing else changes.",
    );
    expect(swapCardText(resolvedSwap({ scope: "today", referenceDate: "2026-10-23" }), TODAY)).toBe(
      "Swap for Fri 23 Oct: Face pull → Band pull-apart (3 × 15, same tags). Nothing else changes.",
    );
  });
  it("rest of plan, every day", () => {
    expect(swapCardText(resolvedSwap({ scope: "rest", days: "every_day" }), TODAY)).toBe(
      "From Tue 20 Oct, Face pull → Band pull-apart on Mon and Fri (14 sessions). Today: swapped too. Past sessions and logs stay as they are.",
    );
  });
  it("rest of plan, this weekday only, with a count from code", () => {
    expect(
      swapCardText(resolvedSwap({ scope: "rest", days: "this_day", affectedSessions: 8 }), TODAY),
    ).toContain("on Mon (8 sessions)");
  });
  it("rest of plan from a later reference date has no Today line", () => {
    const t = swapCardText(
      resolvedSwap({
        scope: "rest",
        days: "every_day",
        referenceDate: "2026-10-23",
        referenceWeekday: "fri",
      }),
      TODAY,
    );
    expect(t.startsWith("From Fri 23 Oct,")).toBe(true);
    expect(t).not.toContain("Today:");
  });
  it("an already logged reference day stays as it is", () => {
    const t = swapCardText(
      resolvedSwap({ scope: "rest", days: "every_day", loggedOnReference: true }),
      TODAY,
    );
    expect(t).toContain("Today: already logged, it stays.");
  });
  it("adds the new exercise line", () => {
    const r = resolvedSwap({
      scope: "today",
      to: {
        id: null,
        name: "Band pull-apart",
        slug: "band_pull_apart",
        isNew: true,
        newSpec: {
          type: "bodyweight_reps",
          loadBasis: null,
          equipmentSlug: null,
          muscleGroup: "back",
        },
      },
    });
    expect(swapCardText(r, TODAY).split("\n")[1]).toBe(
      "New exercise: Band pull-apart · reps only (no load math).",
    );
  });
  it("escapes HTML in names", () => {
    const t = swapCardText(resolvedSwap({ scope: "today", from: { id: 1, name: "A <b>" } }), TODAY);
    expect(t).toContain("A &lt;b&gt;");
  });
});
