/** The render_chart read tool (M8): builds one chart per message; the flow sends it after the reply. */
import type { ChartRequest } from "../charts/index.js";
import type { Db } from "../logging/db.js";
import type { PendingChart, ReadResult, RenderChartInput } from "../logging/types.js";
import { lookupExercise } from "./exercise-lookup.js";
import { notFound } from "./read-tools.js";

export interface ChartSlot {
  chart: PendingChart | null;
}

const refuse = (message: string): ReadResult => ({
  facts: { error: message },
  fallbackHtml: null,
  isError: true,
});

export async function readRenderChart(
  db: Db,
  now: Date,
  input: RenderChartInput,
  slot: ChartSlot,
): Promise<ReadResult> {
  if (slot.chart) return refuse("one chart per message");
  let req: ChartRequest;
  if (input.metric === "volume") {
    req = { kind: "volume", weeks: input.weeks };
  } else {
    if (!input.exercise) return refuse("exercise is required");
    const found = await lookupExercise(db, input.exercise);
    if (found.kind !== "ok") return notFound(found);
    req = {
      kind: "exercise",
      exerciseId: found.exercise.id,
      metric: input.metric,
      weeks: input.weeks,
    };
  }
  const result = await (await import("../charts/index.js")).buildChart(db, req, now);
  if (!result.ok) {
    if (result.reason === "unknown_exercise") return notFound({ kind: "unknown" });
    return { facts: { found: true, chart: false, text: result.text }, fallbackHtml: result.text };
  }
  slot.chart = { png: result.png, caption: result.caption };
  return {
    facts: { found: true, chart: "will be sent after your reply", ...result.facts },
    fallbackHtml: result.caption,
  };
}
