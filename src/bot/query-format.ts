/**
 * Telegram texts for the read-only queries (M4). Pure: every number comes from DB rows,
 * formatted here, never from model text. Output is Telegram HTML unless noted.
 */
import { dateLabel } from "../logging/describe.js";
import type { ResolvedEntry } from "../logging/types.js";
import type { Weekday } from "../plan-import/types.js";
import type { SessionAdvice } from "../progression/session-advice.js";
import type { ExerciseHistory, HistorySession } from "../queries/history.js";
import type { NextItem, PlanChangeLine, PlanOverview } from "../queries/plan-overview.js";
import { cb } from "./callbacks.js";
import { day, esc, formatFinished, guardLength, itemBlock, weekRange } from "./format.js";
import { type LineView, type Message, setsText } from "./log-format.js";
import type { HeavyGroup } from "./session.js";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function entriesOf(s: HistorySession): ResolvedEntry[] {
  return s.sets.map((x) => ({ ...x, band: x.band ?? null, note: null }));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function cleanText(s: HistorySession): string | null {
  const values = s.sets.map((x) => x.clean).filter((c): c is boolean => c !== null);
  if (values.length === 0) return null;
  if (values.every((c) => c)) return "clean";
  if (values.every((c) => !c)) return "not clean";
  return "some not clean";
}

function rirText(s: HistorySession): string | null {
  const last = [...s.sets].reverse().find((x) => x.rir !== null);
  return last ? `RIR ${last.rirPlus ? "4+" : fmt(last.rir as number)}` : null;
}

function setsPart(h: ExerciseHistory, s: HistorySession): string {
  const view: LineView = {
    name: h.exercise.name,
    type: h.exercise.type,
    loadBasis: h.exercise.loadBasis,
    hspuStep: null,
    entries: entriesOf(s),
    place: null,
  };
  const text = setsText(view);
  const only = s.sets[0];
  // The old tool kept just the total: one set whose reps is that total.
  if (s.perSetUnknown && s.sets.length === 1 && only?.reps != null) {
    const prefix = `1 × ${only.reps}`;
    if (text.startsWith(prefix)) {
      return `${only.reps} reps total (split unknown)${text.slice(prefix.length)}`;
    }
  }
  return text;
}

/** "Tue 20 Oct · W4 deload — 3 × 5 · 60 kg · RIR 3 · clean · imported" (plain text). */
export function historyLine(h: ExerciseHistory, s: HistorySession): string {
  const week =
    s.week === null ? null : `W${s.week}${s.isDeload ? " deload" : s.isTest ? " test" : ""}`;
  const pads = unique(s.sets.map((x) => x.padHeight).filter((p): p is number => p !== null));
  const parts = [
    setsPart(h, s),
    s.hspuStep,
    pads.length ? `pad ${pads.map(fmt).join("/")}` : null,
    rirText(s),
    cleanText(s),
    s.source === "import" ? "imported" : null,
  ].filter((p): p is string => !!p);
  return `${[dateLabel(s.sessionDate), week].filter(Boolean).join(" · ")} — ${parts.join(" · ")}`;
}

/** One plain-text line per session, newest first. Also used as facts for the model. */
export function historyLines(h: ExerciseHistory): string[] {
  return h.sessions.map((s) => historyLine(h, s));
}

export function formatHistory(h: ExerciseHistory): string {
  if (h.sessions.length === 0) return `No ${esc(h.exercise.name)} logged yet.`;
  const shown = h.sessions.length;
  const count =
    h.totalSessions > shown
      ? `last ${shown} of ${h.totalSessions} sessions`
      : `${shown} session${shown === 1 ? "" : "s"}`;
  const lines = [`<b>${esc(h.exercise.name)}</b> — ${count}`, ...historyLines(h).map(esc)];
  return guardLength(lines.join("\n"));
}

/** Ambiguous /history: one button per candidate. */
export function formatHistoryChoice(
  said: string,
  candidates: { id: number; name: string }[],
): Message {
  return {
    text: `Which exercise is "${esc(said)}"?`,
    keyboard: candidates.map((c) => [{ text: c.name, data: cb.history(c.id) }]),
  };
}

/** Ambiguous /chart: one button per candidate. */
export function formatChartChoice(
  said: string,
  candidates: { id: number; name: string }[],
): Message {
  return {
    text: `Which exercise is "${esc(said)}"?`,
    keyboard: candidates.map((c) => [{ text: c.name, data: cb.chart(c.id) }]),
  };
}

/** /chart with no argument: the usage line and one button per main lift plus Volume. */
export function formatChartMenu(mainLifts: { id: number; name: string }[]): Message {
  return {
    text: CHART_USAGE,
    keyboard: [
      ...mainLifts.map((l) => [{ text: l.name, data: cb.chart(l.id) }]),
      [{ text: "Volume", data: cb.chart("v") }],
    ],
  };
}

export const CHART_USAGE =
  "Which chart? For example: /chart squat · /chart pull-up · /chart volume";
export const CHART_FAILED = "Sorry, I couldn't draw that chart right now.";
export const CHART_UNKNOWN = "I don't know that exercise. Try /chart squat.";
export const HISTORY_USAGE = "Which exercise? For example: /history squat";
export const HISTORY_UNKNOWN = "I don't know that exercise. Try /history squat.";
export const SESSION_USAGE =
  "Which day? For example: /session mon, /session tomorrow, /session 2026-10-26 or /session 26/10.";

export function formatNext(
  next: NextItem,
  advice?: SessionAdvice | null,
  heavy: HeavyGroup[] = [],
): string {
  switch (next.kind) {
    case "item": {
      const lines = [
        `<b>Next up</b> · ${next.position} of ${next.total}`,
        ...itemBlock(next.item, next.position, next.extras, advice, heavy),
      ];
      return guardLength(lines.join("\n"));
    }
    case "all_done":
      return "Everything in today's session is done or skipped. 💪";
    case "rest":
      return "Rest day, nothing planned. Enjoy it. 😌";
    case "before_start":
      return "The plan hasn't started yet. Try /plan.";
    case "finished":
      return formatFinished();
  }
}

function phaseRange(from: number, to: number): string {
  return from === to ? `W${from}` : `W${from}–${to}`;
}

export function formatPlan(o: PlanOverview): string {
  const lines: string[] = [];
  if (o.status === "before_start") {
    lines.push(`The plan starts on ${day(o.startDate, "ccc d LLL")}.`);
  } else if (o.status === "finished") {
    lines.push(formatFinished());
  } else if (o.week !== null && o.phase !== null && o.weekStart && o.weekEnd) {
    lines.push(`<b>Week ${o.week} · ${esc(o.phase)}</b> · ${weekRange(o.weekStart)}`);
  }
  if (o.phases.length) {
    lines.push(
      "",
      `Phases: ${o.phases.map((p) => `${phaseRange(p.fromWeek, p.toWeek)} ${esc(p.phase)}`).join(" · ")}`,
    );
  }
  if (o.nextDeload) {
    const when =
      o.nextDeload.week === o.week
        ? "this week"
        : `week ${o.nextDeload.week} (from ${day(o.nextDeload.startDate, "ccc d LLL")})`;
    lines.push(`Next deload: ${when}`);
  }
  if (o.nextTrainingDay) {
    const d = o.nextTrainingDay;
    lines.push(`Next training day: ${day(d.date, "ccc d LLL")} — ${esc(d.focus)}`);
  }
  if (o.changes.length) {
    lines.push("", "<b>Changes</b>");
    for (const c of o.changes) lines.push(changeLine(c));
  }
  return guardLength(lines.join("\n").trim());
}

const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
};

function changeLine({ effectiveFrom, change }: PlanChangeLine): string {
  const from = `• From ${day(effectiveFrom, "ccc d LLL")}:`;
  if (change.kind === "swap") {
    const days =
      change.weekdays === "all"
        ? "every day"
        : change.weekdays.map((d) => WEEKDAY_SHORT[d]).join(", ");
    return `${from} ${esc(change.from)} → ${esc(change.to)} (${days})`;
  }
  const dropped =
    change.droppedWeek === null ? "no deload dropped" : `W${change.droppedWeek} deload dropped`;
  return `${from} deload moved to W${change.insertedWeek} (${dropped})`;
}
