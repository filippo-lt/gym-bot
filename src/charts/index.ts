/** Chart entry point (M8). Lazily imported by /chart and the render_chart tool. */
import { DateTime } from "luxon";
import { trainingDate } from "../domain/calendar.js";
import type { Db } from "../logging/db.js";
import { loadPlanEnv, type PlanEnv, weekFor } from "../progression/load-history.js";
import {
  distinctSessions,
  exerciseCaption,
  MIN_SESSIONS,
  notEnoughText,
  nothingToChartText,
  panelPoints,
  volumeCaption,
} from "./caption.js";
import { loadExerciseChartData, loadVolumeRows } from "./load.js";
import { renderPng } from "./render.js";
import { chartKindFor, loadSeries, repsSeries, volumeSeries } from "./series.js";
import { type ChartMetric, exerciseSpec, resolvePanels, volumeSpec } from "./spec.js";

export type { ChartMetric } from "./spec.js";

export type ChartRequest =
  | { kind: "exercise"; exerciseId: number; metric: ChartMetric; weeks?: number }
  | { kind: "volume"; weeks?: number };

export type ChartResult =
  | { ok: true; png: Buffer; caption: string; facts: Record<string, unknown> }
  | { ok: false; reason: "no_numbers" | "not_enough_data" | "unknown_exercise"; text: string };

export { MIN_SESSIONS };

function sinceFor(now: Date, weeks?: number): string | undefined {
  if (!weeks || weeks <= 0) return undefined;
  const today = DateTime.fromISO(trainingDate(now), { zone: "utc" });
  return today.minus({ days: 7 * weeks }).toISODate() ?? undefined;
}

export async function buildChart(db: Db, req: ChartRequest, now: Date): Promise<ChartResult> {
  const since = sinceFor(now, req.weeks);
  if (req.kind === "volume") return buildVolume(db, since, now);

  const data = await loadExerciseChartData(db, req.exerciseId, since);
  if (!data) {
    return { ok: false, reason: "unknown_exercise", text: "I don't know that exercise." };
  }
  const { ex, name, sessions, stepNames } = data;
  const kind = chartKindFor(ex.type);
  if (kind === "none") {
    return { ok: false, reason: "no_numbers", text: nothingToChartText(name) };
  }
  const load = loadSeries(sessions, ex);
  const reps = repsSeries(sessions, ex, stepNames);
  let metric = req.metric;
  let fallbackNote: string | undefined;
  if (kind === "load_reps" && metric === "auto") {
    // No usable e1RM (e.g. no known bodyweight): chart the reps panel alone instead of giving up.
    const e1rm = panelPoints("e1rm", load, reps).length;
    if (e1rm < MIN_SESSIONS && panelPoints("reps", load, reps).length >= MIN_SESSIONS) {
      metric = "reps";
      fallbackNote = "No usable e1RM (no known bodyweight), showing most reps instead.";
    }
  }
  const cap = exerciseCaption(name, ex, kind, load, reps, metric);
  if (!cap) {
    const n = distinctSessions(resolvePanels(kind, metric).panels, load, reps);
    return { ok: false, reason: "not_enough_data", text: notEnoughText(name, n) };
  }
  const png = await renderPng(exerciseSpec(name, ex, kind, load, reps, metric));
  return {
    ok: true,
    png,
    caption: cap.caption,
    facts: fallbackNote ? { ...cap.facts, note: fallbackNote } : cap.facts,
  };
}

async function buildVolume(db: Db, since: string | undefined, now: Date): Promise<ChartResult> {
  const env = await loadPlanEnv(db);
  const currentWeek = env ? volumeWeek(env, trainingDate(now)) : null;
  if (!env || currentWeek === null) {
    return { ok: false, reason: "not_enough_data", text: "Not enough data to chart volume yet." };
  }
  const cells = volumeSeries(await loadVolumeRows(db, since, env), currentWeek);
  if (cells.length === 0) {
    return { ok: false, reason: "not_enough_data", text: "Not enough data to chart volume yet." };
  }
  const thisWeekSets = cells.filter((c) => c.week === currentWeek).reduce((a, c) => a + c.sets, 0);
  const cap = volumeCaption(thisWeekSets, { currentWeek });
  const png = await renderPng(volumeSpec(cells, currentWeek));
  return { ok: true, png, caption: cap.caption, facts: cap.facts };
}

/**
 * Last plan week to chart: the current week while the plan runs, the last plan week once finished,
 * null before the start. Version-aware (plan_weeks of every version), never `plans.weeks`.
 */
function volumeWeek(env: PlanEnv, date: string): number | null {
  if (date < env.startDate) return null;
  const current = weekFor(env, date);
  if (current) return current.week;
  let last = 0;
  for (const rows of env.weeksByVersion.values())
    for (const w of rows) last = Math.max(last, w.week);
  return last > 0 ? last : null;
}
