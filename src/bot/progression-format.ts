/**
 * Plain-English texts for the progression engine's output (M5). Pure: every number is formatted here, in code, from the
 * stored or computed suggestion, never from model text. Strings are plain text (the Telegram layer escapes them).
 */
import { DateTime } from "luxon";
import type { ExerciseType, LoadBasis } from "../plan-import/types.js";
import type {
  HeavyGroup,
  Label,
  ReadinessLevel,
  ReadinessSignal,
  Suggestion,
} from "../progression/types.js";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export const range = (min: number, max: number): string =>
  min === max ? `${fmt(min)}` : `${fmt(min)}–${fmt(max)}`;

export interface ExerciseKind {
  type: ExerciseType;
  loadBasis: LoadBasis | null;
}

/** "12 Oct" */
export function dayMonth(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).setLocale("en").toFormat("d LLL");
}

/**
 * The suggested load in the exercise's unit convention: "62.5 kg", "20 kg per hand", "+5 kg", "BW", "red band".
 * Null when there is no load to show (nothing computed, or the bot has to ask first).
 */
export function loadText(ex: ExerciseKind, s: Suggestion): string | null {
  if (s.ask === "load" || s.ask === "band") return null;
  if (ex.type === "bodyweight_plus") {
    if ((s.addedKg ?? 0) > 0) return `+${fmt(s.addedKg as number)} kg`;
    if ((s.assistKg ?? 0) > 0) {
      return s.band ? `${s.band} band` : `${fmt(s.assistKg as number)} kg assist`;
    }
    return s.addedKg !== undefined || s.assistKg !== undefined ? "BW" : null;
  }
  if (s.loadKg === undefined) return null;
  return `${fmt(s.loadKg)} kg${ex.loadBasis === "per_hand" ? " per hand" : ""}`;
}

export interface LabelContext {
  /** Date of the bodyweight the pull-up suggestion used. */
  bodyweightDate?: string | null;
  /** Heavy Thursday group behind a Friday adjustment, e.g. "legs". */
  heavyGroup?: string | null;
}

const FRIDAY_WHY = (ctx: LabelContext) =>
  ctx.heavyGroup ? `heavy ${ctx.heavyGroup} Thursday` : "heavy Thursday";

/** Short label text, or null when a label needs no words. */
export function labelText(label: Label, ctx: LabelContext = {}): string | null {
  switch (label) {
    case "estimate":
      return "estimate";
    case "estimate_check_first_set":
      return "estimate — check your first set";
    case "back_after_break":
      return "back after a break";
    case "baseline_ask_load":
      return "baseline — tell me your weight";
    case "bw_stale":
      return ctx.bodyweightDate
        ? `BW from ${dayMonth(ctx.bodyweightDate)} — send /bw <kg>`
        : "no bodyweight yet — send /bw <kg>";
    case "fallback_bw":
      return "bodyweight for now";
    case "fallback_assisted":
      return "assisted for now";
    case "max_test_first":
      return "start with one max clean set (stop 1 rep before form breaks)";
    case "friday_reduced":
      return `reduced (${FRIDAY_WHY(ctx)}) — or skip`;
    case "friday_offer_skip":
      return `can skip (${FRIDAY_WHY(ctx)})`;
    case "readiness_yellow":
      return "lighter today (YELLOW)";
    case "readiness_red":
      return "easy volume today (RED)";
  }
}

/** The ask when no load could be computed (SPEC 5.2). */
export function askText(s: Suggestion, ctx: LabelContext = {}): string | null {
  if (s.ask === "load") return "baseline — tell me your weight";
  if (s.ask === "bodyweight") return labelText("bw_stale", ctx);
  if (s.ask === "band") return "tell me how many kg your bands are, e.g. red band 15 kg";
  return null;
}

/** Labels the session view words itself (Friday and readiness changes get their own lines). */
export const SESSION_VIEW_LABELS: readonly Label[] = [
  "friday_reduced",
  "friday_offer_skip",
  "readiness_yellow",
  "readiness_red",
];

/** Label texts of a suggestion, in order, without duplicates (an ask replaces the labels it repeats). */
export function suggestionNotes(
  s: Suggestion | null,
  ctx: LabelContext = {},
  exclude: readonly Label[] = [],
): string[] {
  if (!s) return [];
  const out: string[] = [];
  const add = (t: string | null) => {
    if (t && !out.includes(t)) out.push(t);
  };
  for (const l of s.labels) if (!exclude.includes(l)) add(labelText(l, ctx));
  add(askText(s, ctx));
  return out;
}

const SIGNAL_WORDS: Record<ReadinessSignal["kind"], string> = {
  button_tired: "tired",
  button_ok: "ok",
  button_strong: "feeling strong",
  chat_bad_sleep: "bad sleep",
  chat_sore: "sore",
  chat_exhausted: "exhausted",
  recovery_low: "low recovery score",
  drift: "last session was hard",
};

export function signalWords(kinds: string[]): string {
  const words = kinds
    .map((k) => SIGNAL_WORDS[k as ReadinessSignal["kind"]])
    .filter((w): w is string => !!w && w !== "ok");
  return [...new Set(words)].join(", ");
}

/** Header lines for a YELLOW / RED day; empty for GREEN (plain as written). */
export function levelLines(
  level: ReadinessLevel | null,
  kinds: string[],
  opts: { restDay?: boolean; classAdvice?: boolean } = {},
): string[] {
  if (level !== "YELLOW" && level !== "RED") return [];
  const why = signalWords(kinds);
  const lines: string[] = [];
  if (level === "YELLOW") {
    lines.push(
      `🟡 YELLOW day${why ? ` (${why})` : ""}: main lifts a bit lighter, low-priority items dropped, HIIT halved.`,
    );
  } else {
    lines.push(
      `🔴 RED day${why ? ` (${why})` : ""}: only pull-up, HSPU, handstand at easy volume, plus mobility.`,
    );
  }
  if (opts.classAdvice) lines.push("Go easy in class tonight, or skip it.");
  if (opts.restDay) lines.push("Nothing left for today: a rest day is suggested. 😌");
  return lines;
}

export const FRIDAY_ASK_CLASS = "How was Thursday's class? /class";
export const EARLIER_DELOAD_HINT =
  "💡 You have been run down for a while. It may be worth moving the next deload earlier.";

/** Heavy group (lowercase) that touches an item, from its tags. */
export function heavyGroupFor(
  tags: string[],
  heavy: HeavyGroup[],
  map: Record<HeavyGroup, string[]>,
): string | null {
  for (const g of heavy) if (map[g].some((t) => tags.includes(t))) return g;
  return null;
}
