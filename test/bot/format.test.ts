import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baseItemName,
  esc,
  formatBeforeStart,
  formatFinished,
  formatRest,
  formatSession,
  formatToday,
  formatWeek,
  TELEGRAM_MESSAGE_LIMIT,
} from "../../src/bot/format.js";
import { DAY_FOCUS } from "../../src/bot/session.js";
import { plan, sessionFor, weekFor } from "./helpers.js";

const strip = (s: string) => s.replace(/<[^>]+>/g, "");

describe("swapped item", () => {
  it("shows the replacement with what it replaced today", () => {
    const s = sessionFor(5, "mon", "2026-10-26");
    const first = s.items[0];
    if (!first) throw new Error("no item");
    const swapped = {
      ...s,
      items: [
        {
          ...first,
          options: [{ slug: "face_pull", name: "Face pull" }],
          swappedFrom: "Bench press",
        },
        ...s.items.slice(1),
      ],
    };
    expect(formatToday(swapped)).toContain("<b>Face pull (instead of Bench press today)</b>");
    expect(formatToday(s)).not.toContain("instead of");
  });
});

describe("formatToday", () => {
  it("W5 Monday", () => {
    expect(formatToday(sessionFor(5, "mon", "2026-10-26"))).toMatchSnapshot();
  });

  it("Friday with heavy pull + push", () => {
    const out = formatToday(
      sessionFor(1, "fri", "2026-10-02", { thursday: { heavy: ["pull", "push"] } }),
    );
    expect(out).toMatchSnapshot();
    expect(out).toContain("Thursday class: heavy PULL, PUSH");
    expect(out.match(/⚠️/g)?.length).toBe(2);
  });

  it("Friday not reported has no warnings", () => {
    const out = formatToday(sessionFor(1, "fri", "2026-10-02", { thursday: "not_reported" }));
    expect(out).toContain("Thursday class: not reported");
    expect(out).not.toContain("⚠️");
  });

  it("W4 Tuesday deload", () => {
    expect(formatToday(sessionFor(4, "tue", "2026-10-20"))).toMatchSnapshot();
  });

  it("shows statuses and the extra set", () => {
    const s = sessionFor(11, "mon", "2026-12-07", {
      status: { "w11-mon-01-0": "done", "w11-mon-02-0": "skipped", "w11-mon-03-0": "modified" },
    });
    const out = formatToday(s);
    expect(out).toContain("✓ ");
    expect(out).toContain("⏭ ");
    expect(out).toContain("✎ ");
    expect(out).toContain("+ 1 easy bodyweight set");
  });

  it("uses canonical exercise names", () => {
    const mon = formatToday(sessionFor(5, "mon", "2026-10-26"));
    expect(mon).toContain("<b>Ring row (Australian pull-up)</b> — 3 × 6–8");
    expect(mon).not.toContain("Chest-supported");
    expect(mon).toContain("<b>Pull-up (weighted)</b>");
    const tue5 = formatToday(sessionFor(5, "tue", "2026-10-27"));
    expect(tue5).toMatch(/<b>HSPU — [A-Za-z -]+<\/b>/);
    expect(tue5).not.toContain("your current step");
    expect(tue5).toContain("Handstand</b> — 5–7 min line/balance practice");
    expect(formatToday(sessionFor(1, "fri", "2026-10-02"))).toContain("<b>Triceps extension</b>");
    const w4 = formatToday(sessionFor(4, "mon", "2026-10-19"));
    expect(w4).toMatch(/Pull-up \((weighted, )?deload\)/);
  });

  it("HSPU without a known step", () => {
    const s = sessionFor(5, "tue", "2026-10-27");
    for (const i of s.items) i.hspuStep = null;
    expect(formatToday(s)).toContain("HSPU — your current step");
  });

  it("shortens long raw text at a boundary", () => {
    const s = sessionFor(5, "mon", "2026-10-26");
    const warm = s.items[0];
    if (!warm) throw new Error("no item");
    for (const raw of [
      "Dead hang 2×25s · scapular pull-up 2×8 · band straight-arm pulldown 1×15",
      "Wrist rocks and some very long wordsequence without separators at all here ok",
    ]) {
      warm.prescriptionRaw = raw;
      const line =
        strip(formatToday(s))
          .split("\n")
          .find((l) => l.startsWith("1. ")) ?? "";
      const text = line.split(" — ")[1] ?? "";
      expect(text.length).toBeLessThanOrEqual(60);
      expect(text.endsWith("…")).toBe(true);
      const body = text.slice(0, -1);
      expect(raw.startsWith(body)).toBe(true);
      expect(raw[body.length] === " " || raw[body.length] === undefined).toBe(true);
    }
  });

  it("cuts texts longer than 4000 characters", () => {
    const s = sessionFor(5, "mon", "2026-10-26");
    const base = s.items[2];
    if (!base) throw new Error("no item");
    s.items = Array.from({ length: 300 }, (_, n) => ({ ...base, itemOrder: n }));
    const out = formatToday(s);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith("…")).toBe(true);
    const w = weekFor(1);
    w.days[0] = { ...(w.days[0] as (typeof w.days)[0]), focus: "x".repeat(5000) };
    const wo = formatWeek(w);
    expect(wo.length).toBeLessThanOrEqual(4000);
    expect(wo.endsWith("…")).toBe(true);
  });

  it("has no loads", () => {
    for (const out of [formatToday(sessionFor(5, "mon", "2026-10-26"))]) {
      expect(strip(out)).not.toMatch(/\bkg\b/);
    }
  });

  it("escapes HTML", () => {
    const s = sessionFor(5, "mon", "2026-10-26");
    const item = s.items[0];
    if (!item) throw new Error("no item");
    item.planName = "A <b> & C";
    item.options = [];
    item.tags = ["warmup"];
    item.prescriptionRaw = "x < y & z";
    const out = formatToday(s);
    expect(out).toContain("A &lt;b&gt; &amp; C");
    expect(out).toContain("x &lt; y &amp; z");
    expect(esc("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("every plan day fits in one Telegram message", () => {
    const days = ["mon", "tue", "wed", "thu", "fri"] as const;
    let count = 0;
    for (const w of plan.weeks) {
      for (const [i, d] of days.entries()) {
        const date = new Date(`${w.start_date}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + i);
        const iso = date.toISOString().slice(0, 10);
        for (const thursday of d === "fri"
          ? [
              { heavy: ["pull", "push", "legs"] as ("pull" | "push" | "legs")[] },
              "not_reported" as const,
            ]
          : [undefined]) {
          const out = formatToday(sessionFor(w.week, d, iso, { thursday }));
          expect(out.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
        }
        count++;
      }
      expect(formatWeek(weekFor(w.week)).length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(count).toBe(60);
  });
});

describe("other states", () => {
  it("rest day (Sunday)", () => {
    expect(
      formatRest({ kind: "rest", date: "2026-10-25", week: 4, phase: "Deload" }),
    ).toMatchSnapshot();
  });
  it("before start", () => {
    expect(formatBeforeStart("2026-09-28")).toBe("The plan starts on Mon 28 Sep.");
    expect(formatSession({ kind: "before_start", startDate: "2026-09-28" })).toBe(
      "The plan starts on Mon 28 Sep.",
    );
  });
  it("finished", () => {
    expect(formatFinished()).toBe("The plan is finished.");
  });
});

describe("formatWeek", () => {
  it("W1 with mixed statuses", () => {
    const out = formatWeek(
      weekFor(1, {
        mon: { done: 6 },
        tue: { done: 5, skipped: 1 },
        wed: { done: 2, modified: 1 },
      }),
    );
    expect(out).toMatchSnapshot();
  });
  it("W4 deload header", () => {
    expect(formatWeek(weekFor(4)).split("\n")[0]).toBe("<b>Week 4 · Deload</b> · 19–25 Oct");
  });
});

describe("day focus", () => {
  it("equals day_focus in the plan JSON", () => {
    const json = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../seed/hybrid-strength-plan.json"), "utf8"),
    );
    const names = {
      mon: "Monday",
      tue: "Tuesday",
      wed: "Wednesday",
      thu: "Thursday",
      fri: "Friday",
    } as const;
    for (const [k, v] of Object.entries(names)) {
      expect(DAY_FOCUS[k as keyof typeof names]).toBe(json.day_focus[v]);
    }
  });
});

describe("baseItemName", () => {
  const base = { planName: "Hanging leg raise / knee raise", variantLabel: null };
  it("names several options like /today", () => {
    expect(
      baseItemName({
        ...base,
        options: [
          { slug: "hlr", name: "Hanging leg raise" },
          { slug: "hkr", name: "Hanging knee raise" },
        ],
      }),
    ).toBe("Hanging leg raise or hanging knee raise");
  });
  it("adds the variant to a single option", () => {
    expect(
      baseItemName({
        planName: "⭐Clean strict pull-up",
        variantLabel: "deload",
        options: [{ slug: "pull_up", name: "Pull-up" }],
      }),
    ).toBe("Pull-up (deload)");
  });
});
