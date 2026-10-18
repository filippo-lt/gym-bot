/**
 * Vega-Lite specs (M8). Pure: series in, spec out. The x axis is an ordinal axis of formatted date strings
 * ("29 Sep"), because Vega's default temporal axis renders "12 PM" ticks.
 */
import { DateTime } from "luxon";
import type { TopLevelSpec } from "vega-lite";
import type { ExerciseInfo } from "../progression/types.js";
import { FONT_FAMILY } from "./render.js";
import type { ChartKind, LoadPoint, RepsPoint, VolumeCell } from "./series.js";

export type ChartMetric = "load" | "reps" | "auto";
export type Panel = "e1rm" | "reps" | "seconds";

export function axisUnit(ex: ExerciseInfo): string {
  switch (ex.loadBasis) {
    case "per_hand":
      return "kg per hand";
    case "stack":
      return "kg (stack)";
    case "bodyweight_plus":
      return "kg system load";
    default:
      return "kg";
  }
}

/** Which panels a kind/metric pair draws; `note` is set when "load" had to fall back. */
export function resolvePanels(
  kind: ChartKind,
  metric: ChartMetric,
): { panels: Panel[]; note?: string } {
  if (kind === "none") return { panels: [] };
  const hasLoad = kind === "load" || kind === "load_reps";
  const repsPanel: Panel = kind === "timed" ? "seconds" : "reps";
  if (metric === "reps") return { panels: [repsPanel] };
  if (metric === "load") {
    return hasLoad
      ? { panels: ["e1rm"] }
      : {
          panels: [repsPanel],
          note: `No load math for this exercise, showing ${repsPanel === "seconds" ? "longest hold" : "most reps"} instead.`,
        };
  }
  if (kind === "load_reps") return { panels: ["e1rm", "reps"] };
  return { panels: [hasLoad ? "e1rm" : repsPanel] };
}

/** True when the dates cover more than one calendar year (labels then carry the year). */
export function spansYears(dates: string[]): boolean {
  return new Set(dates.map((d) => d.slice(0, 4))).size > 1;
}

export function dateLabel(date: string, withYear = false): string {
  return DateTime.fromISO(date, { zone: "utc" })
    .setLocale("en")
    .toFormat(withYear ? "d LLL yyyy" : "d LLL");
}

const COLOR = "#2563eb";
const SHADE = "#e5e7eb";
const STEP_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

/**
 * Styling rule, same in every panel: hollow = import-only estimate; deload/test weeks are shown by the shaded
 * band only (their points, where they exist, stay solid).
 */
interface Row {
  label: string;
  value: number | null;
  flagged: boolean;
  hollow: boolean;
  step: string | null;
}

/** The ordinal key is the ISO date (one entry per session date, so the same day-month in two years never collides); `labelExpr` shows the formatted label. */
function xEncoding(dates: string[]) {
  const withYear = spansYears(dates);
  const map = JSON.stringify(Object.fromEntries(dates.map((d) => [d, dateLabel(d, withYear)])));
  return {
    field: "label",
    type: "ordinal" as const,
    sort: null,
    scale: { domain: dates },
    axis: { title: null, labelAngle: -45, labelFontSize: 13, labelExpr: `${map}[datum.value]` },
  };
}

function panelSpec(
  panel: Panel,
  title: string | null,
  unit: string,
  dates: string[],
  rows: Row[],
  byStep: boolean,
  height: number,
) {
  const yTitle =
    panel === "e1rm"
      ? `e1RM (${unit})`
      : panel === "seconds"
        ? "Longest hold (s)"
        : "Most reps in one set";
  const points = rows.filter((r) => r.value != null);
  const shaded = rows.filter((r) => r.flagged).map((r) => ({ label: r.label }));
  const y = {
    field: "value",
    type: "quantitative" as const,
    scale: panel === "e1rm" ? { zero: false, nice: true, padding: 14 } : { zero: true, nice: true },
    axis: { title: yTitle, titleFontSize: 14, labelFontSize: 13 },
  };
  const stepNames = [...new Set(points.map((r) => r.step ?? "?"))];
  const color = byStep
    ? {
        field: "stepName",
        type: "nominal" as const,
        scale: { domain: stepNames, range: STEP_COLORS },
        legend: { title: "Step", orient: "bottom" as const },
      }
    : { value: COLOR };
  const data = points.map((r) => ({ ...r, stepName: r.step ?? "?" }));
  return {
    ...(title ? { title: { text: title, fontSize: 16 } } : {}),
    width: 800,
    height,
    layer: [
      {
        data: { values: shaded },
        mark: { type: "rect" as const, color: SHADE, opacity: 0.8 },
        encoding: { x: xEncoding(dates) },
      },
      {
        data: { values: data },
        mark: { type: "line" as const, strokeWidth: 2, color: byStep ? undefined : COLOR },
        encoding: {
          x: xEncoding(dates),
          y,
          ...(byStep ? { color, detail: { field: "stepName" } } : {}),
        },
      },
      {
        data: { values: data },
        mark: {
          type: "point" as const,
          size: 90,
          strokeWidth: 2,
          filled: true,
          ...(byStep ? {} : { color: COLOR, stroke: COLOR }),
        },
        encoding: {
          x: xEncoding(dates),
          y,
          ...(byStep ? { stroke: color } : {}),
          fill: {
            condition: { test: "datum.hollow", value: "white" },
            ...(byStep
              ? { field: "stepName", type: "nominal" as const, scale: color.scale }
              : { value: COLOR }),
          },
        },
      },
    ],
  };
}

export function exerciseSpec(
  name: string,
  ex: ExerciseInfo,
  kind: ChartKind,
  load: LoadPoint[],
  reps: RepsPoint[],
  metric: ChartMetric,
): TopLevelSpec {
  const { panels } = resolvePanels(kind, metric);
  const unit = axisUnit(ex);
  const dates = [...new Set([...load.map((p) => p.date), ...reps.map((p) => p.date)])].sort();
  const built = panels.map((panel, i) => {
    let rows: Row[];
    if (panel === "e1rm") {
      rows = load.map((p) => ({
        label: p.date,
        value: p.flagged ? null : p.e1rm,
        flagged: p.flagged,
        hollow: p.estimate,
        step: null,
      }));
    } else {
      rows = reps.map((p) => ({
        label: p.date,
        value: panel === "seconds" ? p.seconds : p.bestSet,
        flagged: p.flagged,
        hollow: p.estimate,
        step: p.step,
      }));
    }
    return panelSpec(
      panel,
      i === 0 ? name : null,
      unit,
      dates,
      rows,
      kind === "hspu" && panel === "reps",
      panels.length > 1 ? 220 : 380,
    );
  });
  const base = { background: "white", config: { font: FONT_FAMILY } };
  const spec = built.length > 1 ? { ...base, vconcat: built } : { ...base, ...built[0] };
  return spec as unknown as TopLevelSpec;
}

export function volumeSpec(cells: VolumeCell[], currentWeek: number): TopLevelSpec {
  const weeks = Array.from({ length: currentWeek }, (_, i) => `W${i + 1}`);
  return {
    background: "white",
    config: { font: FONT_FAMILY },
    title: { text: "Weekly sets per muscle group", fontSize: 16 },
    width: 800,
    height: 380,
    data: { values: cells.map((c) => ({ ...c, label: `W${c.week}` })) },
    mark: { type: "bar" },
    encoding: {
      x: {
        field: "label",
        type: "ordinal",
        sort: null,
        scale: { domain: weeks },
        axis: { title: null, labelFontSize: 13, labelAngle: 0 },
      },
      y: {
        field: "sets",
        type: "quantitative",
        aggregate: "sum",
        stack: "zero",
        axis: { title: "Hard sets", titleFontSize: 14, labelFontSize: 13 },
      },
      color: {
        field: "muscleGroup",
        type: "nominal",
        legend: { title: null, orient: "bottom", labelFontSize: 13 },
      },
    },
  } as unknown as TopLevelSpec;
}
