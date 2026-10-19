/** Chart captions and facts (M8): plain text, HTML-escaped, code-formatted numbers, bounded well under Telegram's 1024 by cutting names before escaping. */
import { esc } from "../bot/format.js";
import { fmt } from "../history-import/build.js";
import type { ExerciseInfo } from "../progression/types.js";
import type { ChartKind, LoadPoint, RepsPoint } from "./series.js";
import {
  axisUnit,
  type ChartMetric,
  dateLabel,
  type Panel,
  resolvePanels,
  spansYears,
} from "./spec.js";

const NAME_MAX = 100;
export const MIN_SESSIONS = 2;

/** Names are cut before escaping, so the 1024 cap can never split an HTML entity. */
export function safeName(name: string): string {
  return esc(name.slice(0, NAME_MAX));
}

/** Distinct session dates with data on any of the panels in use. */
export function distinctSessions(panels: Panel[], load: LoadPoint[], reps: RepsPoint[]): number {
  return new Set(panels.flatMap((p) => panelPoints(p, load, reps).map((x) => x.date))).size;
}

const sessionsText = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/** `total` counts every logged session; `n` only those that can be plotted. */
export function notEnoughText(name: string, n: number, total = n): string {
  if (total > n) {
    return `Not enough data to chart ${safeName(name)} yet: ${sessionsText(total)} logged, ${n === 0 ? "none can be plotted yet" : `only ${n} can be plotted`}.`;
  }
  return `Not enough data to chart ${safeName(name)} yet (${sessionsText(n)}).`;
}

export function nothingToChartText(name: string): string {
  return `Nothing to chart for ${safeName(name)}: it's logged as done / skipped.`;
}

export interface ExerciseCaption {
  caption: string;
  facts: Record<string, unknown>;
}

interface Dated {
  date: string;
  value: number;
  step: string | null;
}

export function panelPoints(panel: Panel, load: LoadPoint[], reps: RepsPoint[]): Dated[] {
  const out: Dated[] = [];
  if (panel === "e1rm") {
    for (const p of load)
      if (p.e1rm != null && !p.flagged) out.push({ date: p.date, value: p.e1rm, step: null });
  } else {
    for (const p of reps) {
      const v = panel === "seconds" ? p.seconds : p.bestSet;
      if (v != null) out.push({ date: p.date, value: v, step: p.step });
    }
  }
  return out;
}

/** Null when fewer than two sessions have a point on the primary panel. */
export function exerciseCaption(
  name: string,
  ex: ExerciseInfo,
  kind: ChartKind,
  load: LoadPoint[],
  reps: RepsPoint[],
  metric: ChartMetric,
): ExerciseCaption | null {
  const { panels, note } = resolvePanels(kind, metric);
  const panel = panels[0];
  if (!panel) return null;
  const pts = panelPoints(panel, load, reps);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < MIN_SESSIONS) return null;
  const a = Math.round(first.value * 100) / 100;
  const b = Math.round(last.value * 100) / 100;
  const unit = axisUnit(ex);
  const what =
    panel === "e1rm"
      ? `e1RM ${fmt(a)} → ${fmt(b)} ${unit}`
      : panel === "seconds"
        ? `${fmt(a)} → ${fmt(b)} s`
        : `best set ${fmt(a)} → ${fmt(b)} reps`;
  const parts = [
    safeName(name),
    what,
    `${pts.length} sessions since ${dateLabel(first.date, spansYears(pts.map((p) => p.date)))}`,
  ];
  if (kind === "hspu" && last.step) parts.push(`step ${esc(last.step.slice(0, 50))}`);
  const facts: Record<string, unknown> = {
    exercise: name,
    metric: panel === "e1rm" ? "e1rm" : panel === "seconds" ? "hold_seconds" : "best_set_reps",
    ...(panel === "e1rm" ? { unit } : {}),
    first: a,
    last: b,
    best: Math.round(Math.max(...pts.map((p) => p.value)) * 100) / 100,
    sessions: pts.length,
    firstDate: first.date,
    lastDate: last.date,
    ...(kind === "hspu" && last.step ? { step: last.step } : {}),
    ...(note ? { note } : {}),
  };
  return { caption: parts.join(" · "), facts };
}

export function volumeCaption(
  thisWeekSets: number,
  extra: Record<string, unknown> = {},
): ExerciseCaption {
  return {
    caption: `Weekly sets per muscle group · this week: ${thisWeekSets} sets`,
    facts: { metric: "weekly_sets", thisWeekSets, ...extra },
  };
}
