import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildHistoryImport,
  hashExport,
  renderHistoryReview,
  splitReps,
} from "../../src/history-import/index.js";
import { EQUIPMENT, GOOD_OVERRIDES, planFixture } from "./plan-fixture.js";

const RAW = readFileSync("test/fixtures/history-export.json", "utf8");

function overridesFor(raw: string, extra: Record<string, unknown> = {}) {
  return {
    export_hash: hashExport(raw),
    ...GOOD_OVERRIDES,
    ...extra,
    records: { ...GOOD_OVERRIDES.records, ...((extra.records as object) ?? {}) },
  };
}

function build(raw = RAW, extra: Record<string, unknown> = {}, equipment = EQUIPMENT) {
  return buildHistoryImport(raw, planFixture(), equipment, overridesFor(raw, extra));
}

function group(r: ReturnType<typeof build>, slugKey: string) {
  const g = r.log_groups.find((x) => x.item_key === `${slugKey}-0`);
  if (!g) throw new Error(`no group ${slugKey}`);
  return g;
}

describe("splitReps", () => {
  const item = (s: [number, number], r: [number, number]) => ({
    sets_min: s[0],
    sets_max: s[1],
    reps_min: r[0],
    reps_max: r[1],
  });
  it("splits when exactly one set count fits", () => {
    expect(splitReps(24, item([3, 3], [8, 8]))).toEqual({ reps: [8, 8, 8], unknown: false });
  });
  it("is ambiguous when several set counts fit", () => {
    expect(splitReps(24, item([2, 3], [8, 12]))).toEqual({ reps: [24], unknown: true });
  });
  it("is unknown when nothing fits", () => {
    expect(splitReps(18, item([4, 4], [3, 3]))).toEqual({ reps: [18], unknown: true });
    expect(splitReps(22, item([2, 2], [6, 8]))).toEqual({ reps: [22], unknown: true });
  });
});

describe("buildHistoryImport", () => {
  const r = build();

  it("has no open issues with good overrides", () => {
    expect(r.open_issues).toEqual([]);
  });

  it("creates session items for every non-planned record and no sets for status-only", () => {
    expect(r.session_items.filter((s) => s.week === 1)).toHaveLength(12);
    const warm = r.session_items.find((s) => s.item_key === "w01-mon-00-0");
    expect(warm?.status).toBe("done");
    expect(r.log_groups.find((g) => g.item_key === "w01-mon-00-0")).toBeUndefined();
    expect(r.session_items.find((s) => s.item_key === "w01-tue-00-0")?.status).toBe("skipped");
    expect(r.session_items.find((s) => s.item_key === "w01-mon-03-0")?.status).toBe("modified");
  });

  it("splits reps evenly when unambiguous, otherwise one aggregate entry", () => {
    const row = group(r, "w01-mon-02");
    expect(row.entries.map((e) => e.reps)).toEqual([7, 7, 7]);
    expect(row.per_set_unknown).toBe(false);
    const pull = group(r, "w01-mon-01");
    expect(pull.entries).toHaveLength(1);
    expect(pull.entries[0]?.reps).toBe(13);
    expect(pull.per_set_unknown).toBe(true);
    const leg = group(r, "w01-mon-05");
    expect(leg.per_set_unknown).toBe(true);
    expect(leg.entries[0]?.reps).toBe(30);
  });

  it("sets override replaces the split", () => {
    const o = build(RAW, { records: { "w01-mon-01": { sets: [5, 4, 4] } } });
    const g = group(o, "w01-mon-01");
    expect(g.entries.map((e) => e.reps)).toEqual([5, 4, 4]);
    expect(g.per_set_unknown).toBe(false);
    const o2 = build(RAW, {
      records: { "w01-mon-05": { chosen_option: "hanging_leg_raise", sets: [15, 15] } },
    });
    expect(group(o2, "w01-mon-05").entries.map((e) => e.reps)).toEqual([15, 15]);
  });

  it("converts loads by basis", () => {
    expect(group(r, "w01-mon-03").entries[0]?.load_kg).toBe(65); // 50 plates + 15 bar
    expect(group(r, "w01-mon-04").entries[0]?.load_kg).toBe(42.5); // hack squat sled, as is
    expect(group(r, "w01-mon-06").entries[0]?.load_kg).toBe(8); // per hand
    expect(group(r, "w01-mon-07").entries[0]?.load_kg).toBe(35); // stack
    const wp = group(r, "w01-mon-08").entries[0];
    expect(wp?.added_kg).toBe(5);
    expect(wp?.load_kg).toBeNull();
  });

  it("load_kg_total override wins", () => {
    const o = build(RAW, { records: { "w01-mon-03": { load_kg_total: 72.5 } } });
    expect(group(o, "w01-mon-03").entries[0]?.load_kg).toBe(72.5);
  });

  it("missing barbell base_kg is an open issue", () => {
    const eq = EQUIPMENT.map((e) => (e.slug === "barbell" ? { ...e, base_kg: null } : e));
    const o = build(RAW, {}, eq);
    expect(o.open_issues.map((i) => i.ref)).toContain("w01-mon-03");
    expect(o.log_groups.find((g) => g.item_key === "w01-mon-03-0")).toBeUndefined();
  });

  it("OR item without a choice is an open issue with a snippet", () => {
    const o = buildHistoryImport(RAW, planFixture(), EQUIPMENT, {
      export_hash: hashExport(RAW),
      bodyweight: GOOD_OVERRIDES.bodyweight,
      records: { "w01-mon-05": { chosen_option: "hanging_leg_raise" } },
    });
    const issue = o.open_issues.find((i) => i.ref === "w01-mon-04");
    expect(issue?.code).toBe("or_option_missing");
    expect(issue?.snippet).toContain("chosen_option");
    expect(o.log_groups.find((g) => g.item_key === "w01-mon-04-0")).toBeUndefined();
  });

  it("a hack squat group uses the hack_squat exercise, never squat", () => {
    expect(group(r, "w01-mon-04").exercise_slug).toBe("hack_squat");
    expect(r.log_groups.some((g) => g.exercise_slug === "squat")).toBe(false);
  });

  it("puts RIR on the last set; 4+ sets rir_plus", () => {
    const g = group(r, "w01-mon-03");
    expect(g.entries.map((e) => e.rir)).toEqual([null, 4]);
    expect(g.entries.map((e) => e.rir_plus)).toEqual([false, true]);
    const lat = group(r, "w01-mon-06");
    expect(lat.entries.map((e) => e.rir)).toEqual([null, 2]);
    expect(lat.entries.map((e) => e.rir_plus)).toEqual([false, false]);
  });

  it("pull-ups are clean unless the notes say otherwise", () => {
    expect(group(r, "w01-mon-01").entries.every((e) => e.clean === true)).toBe(true);
    expect(group(r, "w01-mon-08").entries.every((e) => e.clean === false)).toBe(true);
    expect(group(r, "w01-mon-02").entries[0]?.clean).toBeNull();
  });

  it("sets group defaults", () => {
    const g = group(r, "w01-mon-01");
    expect(g.readiness_level).toBe("GREEN");
    expect(g.bw_kg).toBe(70);
    expect(g.sub_item).toBe(0);
    // 12:00 Europe/Rome in late September is CEST (UTC+2)
    expect(g.performed_at).toBe("2026-09-28T10:00:00.000Z");
  });

  it("import_row_key is date/plan name/index", () => {
    expect(group(r, "w01-mon-03").import_row_key).toBe("2026-09-28/Bench press/3");
    expect(r.session_items.find((s) => s.item_key === "w01-mon-05-0")?.import_row_key).toBe(
      "2026-09-28/Hanging leg raise / knee raise/5",
    );
  });

  it("exposure rules", () => {
    const w1 = r.class_logs.find((c) => c.week === 1);
    expect(w1).toMatchObject({ date: "2026-10-01", heavy_groups: ["pull", "legs"] });
    const w2 = r.class_logs.find((c) => c.week === 2);
    expect(w2).toMatchObject({ date: "2026-10-08", heavy_groups: [] });
    expect(r.class_logs.find((c) => c.week === 3)).toBeUndefined();
  });

  it("parses weekly metrics", () => {
    const m = (name: string) => r.weekly_metrics.find((x) => x.metric === name);
    expect(m("pullups")).toMatchObject({ value_num: 4, unit: "reps" });
    expect(m("weighted")).toMatchObject({ value_num: 2.5, unit: "kg" });
    expect(m("hspu")).toMatchObject({ value_num: null, value_text: "Feet up" });
    expect(m("recovery")).toMatchObject({ value_num: 3, unit: "score_1_5" });
    expect(m("bench")).toMatchObject({ value_num: 9, unit: "reps" });
    expect(r.weekly_metrics).toHaveLength(7);
  });

  it("bodyweight row comes from overrides", () => {
    expect(r.bodyweight).toEqual({ date: "2026-09-28", kg: 70, source: "import" });
  });
});

describe("extra checks", () => {
  it("session dates follow the plan weeks", () => {
    const raw = JSON.stringify({
      weeks: {
        "2": { days: { Monday: { "0": { status: "done" } } } },
        "3": { days: { Friday: { "0": { status: "done" } } } },
      },
    });
    const o = build(raw);
    expect(o.session_items.find((s) => s.item_key === "w02-mon-00-0")?.session_date).toBe(
      "2026-10-05",
    );
    expect(o.session_items.find((s) => s.item_key === "w03-fri-00-0")?.session_date).toBe(
      "2026-10-16",
    );
  });

  it("override sets must add up to the logged total", () => {
    const o = build(RAW, {
      records: { "w01-mon-02": { sets: [7, 7, 6] } },
    });
    expect(o.open_issues.map((i) => i.code)).toContain("override_sum_mismatch");
  });

  it("content on a skipped record is an open issue, resolvable by a comment", () => {
    const raw = JSON.stringify({
      weeks: { "1": { days: { Monday: { "2": { status: "skipped", actual: "21" } } } } },
    });
    expect(build(raw).open_issues.map((i) => i.code)).toContain("content_on_skipped");
    const ok = build(raw, { records: { "w01-mon-02": { comment: "I did it" } } });
    expect(ok.open_issues).toEqual([]);
  });

  it("missing bodyweight is an open issue", () => {
    const o = buildHistoryImport(RAW, planFixture(), EQUIPMENT, {
      export_hash: hashExport(RAW),
      bodyweight: null,
      records: GOOD_OVERRIDES.records,
    });
    expect(o.open_issues.map((i) => i.code)).toContain("bodyweight_missing");
    expect(o.bodyweight).toBeNull();
  });
});

describe("overrides validation", () => {
  it("unknown keys, bad slugs, unknown records and bad options become open issues", () => {
    const o = build(RAW, {
      records: {
        "w01-mon-01": { bogus: 1 },
        "mon-1": { sets: [1] },
        "w09-mon-01": { sets: [1] },
        "w01-mon-02": { chosen_option: "ring_row_xl" },
      },
    });
    const codes = o.open_issues.map((i) => i.code).sort();
    expect(codes).toEqual(
      [
        "override_bad_option",
        "override_bad_slug",
        "override_invalid",
        "override_unknown_record",
      ].sort(),
    );
  });

  it("an export hash mismatch is an open issue", () => {
    const o = buildHistoryImport(RAW, planFixture(), EQUIPMENT, {
      ...overridesFor(RAW),
      export_hash: "0".repeat(64),
    });
    expect(o.open_issues.map((i) => i.code)).toContain("export_hash_mismatch");
  });

  it("a wrongly shaped overrides file is an open issue, not a throw", () => {
    const o = buildHistoryImport(RAW, planFixture(), EQUIPMENT, { nope: true });
    expect(o.open_issues.map((i) => i.code)).toContain("overrides_invalid");
  });
});

describe("renderHistoryReview", () => {
  it("lists groups, conversions, issues and the RIR note", () => {
    const md = renderHistoryReview(build());
    expect(md).toContain("50 + 15 bar = 65 kg");
    expect(md).toContain("2026-09-28/Bench press/3");
    expect(md).toContain("Only 3 set(s) have an RIR");
    expect(md).toContain("Class logs");
    const withIssue = renderHistoryReview(
      buildHistoryImport(RAW, planFixture(), EQUIPMENT, {
        export_hash: hashExport(RAW),
        bodyweight: GOOD_OVERRIDES.bodyweight,
        records: {},
      }),
    );
    expect(withIssue).toContain("chosen_option");
  });
});
