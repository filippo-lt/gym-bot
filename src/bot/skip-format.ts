/** Telegram texts and keyboards for /skip. Pure; plan names are escaped (Telegram HTML). */
import { dateLabel } from "../logging/describe.js";
import type { LedgerResult, SkipTarget } from "../logging/types.js";
import { cb } from "./callbacks.js";
import { esc } from "./format.js";
import type { Keyboard, Message } from "./log-format.js";

export const LIST_HEADER = "Skip what?";
export const NO_SESSION = "No session today.";
export const NOTHING_TO_SKIP = "Nothing left to skip today.";
export const SKIP_STALE = "Already done or skipped.";
export const NOTHING_SKIPPED = "Nothing skipped: already done or skipped.";
export const NOTHING_SKIPPED_DONE = "Nothing skipped ✓";
export const SKIPPED_DONE = "Skipped ✓";

type SkipResult = Extract<LedgerResult, { kind: "skip" }>;

/** "Skip what? (Mon 19 Oct)": one button per open item, PRIMARY ones starred, then the whole day. */
export function skipList(date: string, open: SkipTarget[]): Message {
  const keyboard: Keyboard = open.map((t) => [
    {
      text: `${t.priority === "PRIMARY" ? "⭐ " : ""}${t.label ?? t.planName}`,
      data: cb.skip(date, t.plannedItemId),
    },
  ]);
  keyboard.push([{ text: "Whole session", data: cb.skip(date, "all") }]);
  return { text: `${LIST_HEADER} (${dateLabel(date)})`, keyboard };
}

const planNames = (r: SkipResult) => r.items.map((i) => esc(i.label ?? i.planName)).join(", ");

/** The echo after a skip was saved, with Undo; nothing skipped has no button. */
export function skipEcho(r: SkipResult, sourceKey: string, index: number): Message {
  if (r.items.length === 0) return { text: NOTHING_SKIPPED, keyboard: [] };
  const text = r.whole
    ? `Skipped the whole session (${dateLabel(r.sessionDate)}): ${planNames(r)}`
    : `Skipped: ${planNames(r)}`;
  return { text, keyboard: [[{ text: "Undo", data: cb.undoSkip(sourceKey, index) }]] };
}

export function skipUndone(names: string[]): Message {
  return { text: `Skip undone: ${names.map(esc).join(", ")}`, keyboard: [] };
}
