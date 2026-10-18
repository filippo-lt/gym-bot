import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import type { Equipment, ParsedItem, ResolvedPlan, Weekday } from "../plan-import/types.js";
import { ExportSchema } from "./export-schema.js";
import { hashExport, validateOverrides } from "./overrides.js";
import type {
  ClassLogRow,
  HistoryImport,
  HistoryIssue,
  LogEntryRow,
  LogGroupRow,
  ReviewRow,
  SessionItemRow,
  WeeklyMetricRow,
} from "./types.js";

const DAY_KEYS: Record<string, { wd: Weekday; offset: number }> = {
  Monday: { wd: "mon", offset: 0 },
  Tuesday: { wd: "tue", offset: 1 },
  Wednesday: { wd: "wed", offset: 2 },
  Thursday: { wd: "thu", offset: 3 },
  Friday: { wd: "fri", offset: 4 },
};

const METRIC_UNITS: Record<string, string | null> = {
  pullups: "reps",
  hspureps: "reps",
  bench: "reps",
  squat: "reps",
  ohp: "reps",
  weighted: "kg",
  recovery: "score_1_5",
  hspu: null,
};
const TEXT_METRICS = new Set(["hspu"]);
const EXPOSURE_ORDER = ["pull", "push", "legs"] as const;
const PULL_UP = "pull_up";
const NOT_CLEAN = /not clean|\bkip|assisted/i;
const EXPOSURE_PLAN_NAME = "Thursday exposure";

const pad2 = (n: number) => String(n).padStart(2, "0");
export const fmt = (n: number): string => String(Math.round(n * 100) / 100);

function parseNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function recordSlug(week: number, wd: Weekday, index: number): string {
  return `w${pad2(week)}-${wd}-${pad2(index)}`;
}

function rangeOf(min: number | null, max: number | null): number[] {
  if (min === null) return [];
  const hi = max ?? min;
  const out: number[] = [];
  for (let n = min; n <= hi; n++) out.push(n);
  return out;
}

/** Equal split when exactly one planned set count divides the total into an in-range rep count. */
export function splitReps(
  total: number,
  item: Pick<ParsedItem, "sets_min" | "sets_max" | "reps_min" | "reps_max">,
): { reps: number[]; unknown: boolean } {
  const sets = rangeOf(item.sets_min, item.sets_max);
  const lo = item.reps_min;
  const hi = item.reps_max ?? item.reps_min;
  const fits =
    lo === null || hi === null
      ? []
      : sets.filter((s) => s > 0 && total % s === 0 && total / s >= lo && total / s <= hi);
  const only = fits.length === 1 ? fits[0] : undefined;
  if (only !== undefined) return { reps: Array<number>(only).fill(total / only), unknown: false };
  return { reps: [total], unknown: true };
}

function performedAt(date: string): string {
  const dt = DateTime.fromISO(`${date}T12:00:00`, { zone: APP_TIMEZONE }).toUTC().toISO();
  if (!dt) throw new Error(`Bad date ${date}`);
  return dt;
}

function addDays(date: string, days: number): string {
  const d = DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate();
  if (!d) throw new Error(`Bad date ${date}`);
  return d;
}

interface LoadResult {
  load_kg: number | null;
  added_kg: number | null;
  text: string;
  issue: string | null;
}

function convertLoad(
  rawLoad: string,
  basis: string | null,
  baseKg: number | null | undefined,
  override: number | undefined,
): LoadResult {
  const none: LoadResult = { load_kg: null, added_kg: null, text: "no load", issue: null };
  const target = (v: number, text: string): LoadResult =>
    basis === "bodyweight_plus"
      ? { load_kg: null, added_kg: v, text: `added ${fmt(v)} kg${text}`, issue: null }
      : { load_kg: v, added_kg: null, text: `${fmt(v)} kg${text}`, issue: null };
  if (override !== undefined) return target(override, " (override)");
  const raw = rawLoad.trim();
  if (raw === "") return none;
  const n = parseNum(raw);
  if (n === null) return { ...none, text: `"${raw}"`, issue: `load "${raw}" is not a number` };
  switch (basis) {
    case "barbell_total":
      if (baseKg === null || baseKg === undefined)
        return {
          ...none,
          text: `${raw}`,
          issue: "the barbell has no base_kg in seed/equipment.json",
        };
      return {
        load_kg: n + baseKg,
        added_kg: null,
        text: `${fmt(n)} + ${fmt(baseKg)} bar = ${fmt(n + baseKg)} kg`,
        issue: null,
      };
    case "per_hand":
      return { load_kg: n, added_kg: null, text: `${fmt(n)} kg per hand`, issue: null };
    case "stack":
      return {
        load_kg: n,
        added_kg: null,
        text: `${fmt(n)} kg of plates, sled not added`,
        issue: null,
      };
    case "bodyweight_plus":
      return { load_kg: null, added_kg: n, text: `added ${fmt(n)} kg`, issue: null };
    default:
      return {
        ...none,
        text: `${raw}`,
        issue: "this exercise has no load rule, so the load cannot be converted",
      };
  }
}

function parseRir(raw: string): { rir: number | null; plus: boolean; bad: boolean } {
  const t = raw.trim();
  if (t === "") return { rir: null, plus: false, bad: false };
  const m = /^(\d+(?:[.,]\d+)?)\s*(\+?)$/.exec(t);
  if (!m?.[1]) return { rir: null, plus: false, bad: true };
  return { rir: Number(m[1].replace(",", ".")), plus: m[2] === "+", bad: false };
}

export function buildHistoryImport(
  exportJson: string,
  resolvedPlan: ResolvedPlan,
  equipment: Equipment[],
  overridesRaw: unknown,
): HistoryImport {
  const plan = resolvedPlan.plan;
  const issues: HistoryIssue[] = [];
  const exportHash = hashExport(exportJson);
  const itemsByKey = new Map(plan.items.map((i) => [i.key, i]));
  const exercisesBySlug = new Map(plan.exercises.map((e) => [e.slug, e]));
  const equipmentBySlug = new Map(equipment.map((e) => [e.slug, e]));
  const weeksByNum = new Map(plan.weeks.map((w) => [w.week, w]));

  const ov = validateOverrides(overridesRaw, itemsByKey);
  issues.push(...ov.issues);
  if (ov.export_hash !== null && ov.export_hash !== exportHash) {
    issues.push({
      code: "export_hash_mismatch",
      ref: "overrides",
      detail:
        "The export file changed since the overrides were written. Check that the overrides still fit, then set export_hash to the value below.",
      snippet: `"export_hash": "${exportHash}"`,
    });
  }

  let parsedExport: ReturnType<typeof ExportSchema.safeParse>;
  try {
    parsedExport = ExportSchema.safeParse(JSON.parse(exportJson));
  } catch {
    parsedExport = ExportSchema.safeParse(undefined);
  }
  const result: HistoryImport = {
    export_hash: exportHash,
    session_items: [],
    log_groups: [],
    class_logs: [],
    weekly_metrics: [],
    bodyweight: ov.bodyweight ? { ...ov.bodyweight, source: "import" } : null,
    review_rows: [],
    open_issues: issues,
  };
  if (!parsedExport.success) {
    issues.push({
      code: "export_invalid",
      ref: "export",
      detail: `The export file has an unexpected shape: ${parsedExport.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    });
    return result;
  }

  const weekNums = Object.keys(parsedExport.data.weeks)
    .map(Number)
    .sort((a, b) => a - b);

  for (const week of weekNums) {
    const wk = parsedExport.data.weeks[String(week)];
    if (!wk) continue;
    const planWeek = weeksByNum.get(week);
    if (!planWeek) {
      issues.push({
        code: "unknown_week",
        ref: `w${pad2(week)}`,
        detail: `Week ${week} is not in the plan.`,
      });
      continue;
    }

    // Weekly metrics
    for (const [metric, rawValue] of Object.entries(wk.progress ?? {})) {
      const text = rawValue.trim();
      if (text === "") continue;
      if (!(metric in METRIC_UNITS)) {
        issues.push({
          code: "unknown_metric",
          ref: `w${pad2(week)}/${metric}`,
          detail: `Weekly value "${metric}" is not known.`,
        });
        continue;
      }
      const unit = METRIC_UNITS[metric] ?? null;
      const num = TEXT_METRICS.has(metric) ? null : parseNum(text);
      result.weekly_metrics.push({
        plan_week: week,
        metric,
        value_num: num,
        value_text: num === null ? text : null,
        unit: num === null && !TEXT_METRICS.has(metric) ? null : unit,
        source: "import",
        import_row_key: `w${pad2(week)}/${metric}`,
      } satisfies WeeklyMetricRow);
    }

    // Records
    let exposureDone = false;
    for (const [dayName, day] of Object.entries(wk.days ?? {})) {
      const dayInfo = DAY_KEYS[dayName];
      if (!dayInfo) {
        issues.push({
          code: "unknown_day",
          ref: `w${pad2(week)}`,
          detail: `Day "${dayName}" is not a plan day.`,
        });
        continue;
      }
      const sessionDate = addDays(planWeek.start_date, dayInfo.offset);
      const indexes = Object.keys(day)
        .map(Number)
        .sort((a, b) => a - b);
      for (const index of indexes) {
        const rec = day[String(index)];
        if (!rec) continue;
        const slug = recordSlug(week, dayInfo.wd, index);
        const item = itemsByKey.get(`${slug}-0`);
        const hasContent = [rec.actual, rec.load, rec.rir, rec.notes].some((v) => v.trim() !== "");
        if (rec.status === "planned" && !hasContent) continue;
        if (!item) {
          issues.push({
            code: "unknown_item",
            ref: slug,
            detail: `Record ${slug} has no matching plan item.`,
          });
          continue;
        }
        if (item.plan_name === EXPOSURE_PLAN_NAME && rec.status === "done") exposureDone = true;
        const rowKey = `${sessionDate}/${item.plan_name}/${index}`;
        const o = ov.records[slug] ?? {};

        // Which exercise?
        let chosen: string | null = null;
        if (item.exercise_options.length === 1) chosen = item.exercise_options[0] ?? null;
        else if (o.chosen_option) chosen = o.chosen_option;

        if (rec.status !== "planned") {
          result.session_items.push({
            import_row_key: rowKey,
            session_date: sessionDate,
            item_key: item.key,
            week,
            status: rec.status,
            chosen_exercise_slug: chosen,
          } satisfies SessionItemRow);
        }
        if (!hasContent) continue;

        const review: ReviewRow = {
          key: rowKey,
          date: sessionDate,
          week,
          weekday: dayInfo.wd,
          plan_exercise: item.plan_name,
          chosen,
          raw: { actual: rec.actual, load: rec.load, rir: rec.rir, notes: rec.notes },
          sets_text: "",
          load_text: "",
          rir_text: "",
          flags: [],
        };
        result.review_rows.push(review);

        if ((rec.status === "skipped" || rec.status === "planned") && !o.comment && !o.sets) {
          issues.push({
            code: "content_on_skipped",
            ref: slug,
            detail: `Record ${slug} is "${rec.status}" but has numbers or notes. Confirm it with a comment, or give the sets.`,
            snippet: `"${slug}": { "comment": "ok, I did it" }`,
          });
          review.flags.push(`OPEN: ${rec.status} but has data`);
        }

        if (chosen === null) {
          issues.push({
            code: "or_option_missing",
            ref: slug,
            detail: `${item.plan_name} (${sessionDate}) is an OR item. Which one did you do? Options: ${item.exercise_options.join(", ")}.`,
            snippet: `"${slug}": { "chosen_option": "${item.exercise_options.join('" or "')}" }`,
          });
          review.flags.push("OPEN: exercise not chosen");
          continue;
        }
        const exercise = exercisesBySlug.get(chosen);
        if (!exercise) {
          issues.push({
            code: "unknown_exercise",
            ref: slug,
            detail: `Exercise ${chosen} is not in the plan.`,
          });
          continue;
        }

        let rowOk = true;
        const fail = (code: string, detail: string, snippet?: string) => {
          rowOk = false;
          issues.push({ code, ref: slug, detail, ...(snippet ? { snippet } : {}) });
          review.flags.push(`OPEN: ${detail}`);
        };

        // Reps
        let reps: (number | null)[];
        let unknown = false;
        const actualText = rec.actual.trim();
        if (o.sets) {
          reps = o.sets;
          const declared = actualText === "" ? null : parseNum(actualText);
          const sum = o.sets.reduce((a, b) => a + b, 0);
          if (declared !== null && sum !== declared)
            fail(
              "override_sum_mismatch",
              `sets ${o.sets.join("+")} = ${sum}, but the logged total is ${declared}.`,
            );
          review.sets_text = `${o.sets.length} sets: ${o.sets.join(" / ")} (override)`;
        } else if (actualText === "") {
          reps = [null];
          review.sets_text = "no reps logged";
        } else {
          const total = parseNum(actualText);
          if (total === null || !Number.isInteger(total)) {
            fail(
              "actual_not_number",
              `"actual" is "${actualText}", not a whole number of reps. Give the reps per set.`,
              `"${slug}": { "sets": [8, 8, 8] }`,
            );
            reps = [null];
          } else {
            const split = splitReps(total, item);
            reps = split.reps;
            unknown = split.unknown;
            review.sets_text = unknown
              ? `1 × ${total} (set split unknown)`
              : `${reps.length} × ${reps[0]}`;
            if (unknown) review.flags.push("per_set_unknown");
          }
        }

        // Load
        const equipmentSlug = exercise.equipment_slug;
        const baseKg = equipmentSlug ? equipmentBySlug.get(equipmentSlug)?.base_kg : null;
        const load = convertLoad(rec.load, exercise.load_basis, baseKg, o.load_kg_total);
        review.load_text = load.text;
        if (load.issue)
          fail(
            "load_unconvertible",
            `${load.issue} (${exercise.slug}, "${rec.load}").`,
            `"${slug}": { "load_kg_total": 0 }`,
          );

        // RIR
        const rir = parseRir(rec.rir);
        if (rir.bad) review.flags.push(`rir "${rec.rir.trim()}" is not a number, kept in the note`);
        review.rir_text =
          rir.rir === null ? "" : `${fmt(rir.rir)}${rir.plus ? "+" : ""} (last set)`;
        if (rir.plus) review.flags.push("rir_plus");

        if (!rowOk) continue;

        const notes = rec.notes.trim();
        const noteParts = [notes, rir.bad ? `RIR: ${rec.rir.trim()}` : ""].filter(Boolean);
        const clean = exercise.slug === PULL_UP ? !NOT_CLEAN.test(notes) : null;
        if (clean === false) review.flags.push("not clean");
        if (o.comment) review.flags.push(`comment: ${o.comment}`);

        const entries: LogEntryRow[] = reps.map((r, i) => {
          const last = i === reps.length - 1;
          return {
            set_index: i + 1,
            reps: r,
            load_kg: load.load_kg,
            added_kg: load.added_kg,
            assist_kg: null,
            duration_s: null,
            distance_m: null,
            pad_height: null,
            rir: last ? rir.rir : null,
            rir_plus: last ? rir.plus : false,
            clean,
            note: last && noteParts.length ? noteParts.join(" | ") : null,
          };
        });

        result.log_groups.push({
          import_row_key: rowKey,
          session_date: sessionDate,
          performed_at: performedAt(sessionDate),
          item_key: item.key,
          week,
          sub_item: 0,
          exercise_slug: exercise.slug,
          bw_kg: ov.bodyweight?.kg ?? null,
          readiness_level: "GREEN",
          source: "import",
          per_set_unknown: unknown,
          entries,
        } satisfies LogGroupRow);
      }
    }

    // Exposure -> class_logs on Thursday
    const flags = wk.exposure;
    if (flags) {
      const heavy = EXPOSURE_ORDER.filter((g) => flags[g] === true);
      if (heavy.length > 0 || exposureDone) {
        result.class_logs.push({
          date: addDays(planWeek.start_date, 3),
          week,
          heavy_groups: heavy,
          source: "import",
        } satisfies ClassLogRow);
      }
    }
  }

  return result;
}
