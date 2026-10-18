/**
 * Telegram texts for plan changes (M7). Pure: every number (sets × reps, session count) comes
 * from the resolved swap, which code built from plan rows. Output is Telegram HTML, so names
 * are escaped.
 */
import { trainingDate } from "../domain/calendar.js";
import type { ResolvedSwap } from "../logging/types.js";
import { addDays } from "../plan-import/build-plan.js";
import type { LoadBasis, Weekday } from "../plan-import/types.js";
import { cb } from "./callbacks.js";
import { day, esc } from "./format.js";

type QuestionButtons = [label: string, data: string][];

const dateText = (date: string) => day(date, "ccc d LLL");
const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
};
const WEEKDAY_PLURAL: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
};

/** "Mon", "Mon and Fri", "Mon, Wed and Fri". */
function weekdayList(days: Weekday[]): string {
  const names = days.map((d) => WEEKDAY_SHORT[d]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const refLabel = (r: ResolvedSwap, today: string) =>
  r.referenceDate === today ? "today" : dateText(r.referenceDate);

const swapLine = (r: ResolvedSwap) => `${esc(r.from.name)} → ${esc(r.to.name)}`;

/** Weekdays a "rest of plan" swap touches under the current `days`. */
function affectedWeekdays(r: ResolvedSwap): Weekday[] {
  return r.days === "this_day" ? [r.referenceWeekday] : r.futureWeekdays;
}

export function swapScopeQuestion(
  r: ResolvedSwap,
  pendingId: number,
  today: string = trainingDate(new Date()),
): { text: string; buttons: QuestionButtons } {
  return {
    text: `Swap ${swapLine(r)}. For which sessions?`,
    buttons: [
      [`Only ${refLabel(r, today)}`, cb.swap(pendingId, "t")],
      ["Rest of plan", cb.swap(pendingId, "r")],
    ],
  };
}

export function swapDaysQuestion(
  r: ResolvedSwap,
  pendingId: number,
  _today: string = trainingDate(new Date()),
): { text: string; buttons: QuestionButtons } {
  return {
    text: `${esc(r.from.name)} is on ${weekdayList(r.futureWeekdays)}. Swap it on which days?`,
    buttons: [
      [`Only ${WEEKDAY_PLURAL[r.referenceWeekday]}`, cb.swap(pendingId, "d")],
      ["Every day", cb.swap(pendingId, "a")],
    ],
  };
}

const LOAD_BASIS_WORDS: Record<LoadBasis, string> = {
  barbell_total: "barbell, total load",
  per_hand: "per hand",
  stack: "machine stack",
  bodyweight_plus: "bodyweight plus weight",
};

/** How a new exercise is classified, in words, so a wrong guess is visible before ✅. */
function classification(spec: NonNullable<ResolvedSwap["to"]["newSpec"]>): string {
  switch (spec.type) {
    case "weighted":
      return spec.loadBasis ? `weighted, ${LOAD_BASIS_WORDS[spec.loadBasis]}` : "weighted";
    case "bodyweight_plus":
      return "bodyweight plus weight";
    case "bodyweight_reps":
      return "reps only (no load math)";
    case "skill_ladder":
      return "skill progression";
    case "timed":
      return "timed (no load math)";
    case "distance":
      return "distance";
    case "skill_practice":
      return "skill practice (no load math)";
    case "hiit":
      return "intervals";
    case "mobility":
      return "mobility (no load math)";
    case "warmup":
      return "warm-up (no load math)";
    case "class":
      return "class";
    case "recovery":
      return "recovery (no load math)";
  }
}

export function swapCardText(r: ResolvedSwap, today: string = trainingDate(new Date())): string {
  const lines: string[] = [];
  if (r.scope === "rest") {
    const from = r.referenceDate > addDays(today, 1) ? r.referenceDate : addDays(today, 1);
    const n = r.affectedSessions;
    let text =
      n === 0
        ? `From ${dateText(from)}, ${swapLine(r)}: no later sessions have it.`
        : `From ${dateText(from)}, ${swapLine(r)} on ${weekdayList(affectedWeekdays(r))} (${n} session${n === 1 ? "" : "s"}).`;
    if (r.referenceDate === today) {
      text += r.loggedOnReference ? " Today: already logged, it stays." : " Today: swapped too.";
    }
    lines.push(`${text} Past sessions and logs stay as they are.`);
  } else if (r.scope === "today") {
    const detail = r.prescription ? `${r.prescription}, same tags` : "same tags";
    lines.push(`Swap for ${refLabel(r, today)}: ${swapLine(r)} (${detail}). Nothing else changes.`);
  } else {
    lines.push(`Swap ${swapLine(r)}.`);
  }
  if (r.to.newSpec) {
    lines.push(`New exercise: ${esc(r.to.name)} · ${classification(r.to.newSpec)}.`);
  }
  return lines.join("\n");
}
