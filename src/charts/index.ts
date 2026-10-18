/** Chart entry point (M8). Lazily imported by /chart and the render_chart tool. */
import { desc } from "drizzle-orm";
import { DateTime } from "luxon";
import { plans } from "../db/schema/index.js";
import { planWeekFor, trainingDate } from "../domain/calendar.js";
import type { Db } from "../logging/db.js";
import {
  exerciseCaption,
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

export const MIN_SESSIONS = 2;

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
  if (kind === "load_reps" && metric === "auto") {
    // No usable e1RM (e.g. no known bodyweight): chart the reps panel alone instead of giving up.
    const e1rm = panelPoints("e1rm", load, reps).length;
    if (e1rm < MIN_SESSIONS && panelPoints("reps", load, reps).length >= MIN_SESSIONS) {
      metric = "reps";
    }
  }
  const cap = exerciseCaption(name, ex, kind, load, reps, metric);
  if (!cap) {
    const primary = resolvePanels(kind, metric).panels[0];
    const n = primary ? panelPoints(primary, load, reps).length : 0;
    return { ok: false, reason: "not_enough_data", text: notEnoughText(name, n) };
  }
  const png = await renderPng(exerciseSpec(name, ex, kind, load, reps, metric));
  return { ok: true, png, caption: cap.caption, facts: cap.facts };
}

async function buildVolume(db: Db, since: string | undefined, now: Date): Promise<ChartResult> {
  const [plan] = await db.select().from(plans).orderBy(desc(plans.id)).limit(1);
  const status = plan ? planWeekFor(trainingDate(now), plan.startDate, plan.weeks) : null;
  if (!plan || !status || status.status === "before_start") {
    return { ok: false, reason: "not_enough_data", text: "Not enough data to chart volume yet." };
  }
  const currentWeek = status.status === "active" ? status.week : plan.weeks;
  const cells = volumeSeries(await loadVolumeRows(db, since), currentWeek);
  if (cells.length === 0) {
    return { ok: false, reason: "not_enough_data", text: "Not enough data to chart volume yet." };
  }
  const thisWeekSets = cells.filter((c) => c.week === currentWeek).reduce((a, c) => a + c.sets, 0);
  const cap = volumeCaption(thisWeekSets, { currentWeek });
  const png = await renderPng(volumeSpec(cells, currentWeek));
  return { ok: true, png, caption: cap.caption, facts: cap.facts };
}
