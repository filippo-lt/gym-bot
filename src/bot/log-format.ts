/**
 * Telegram texts and keyboards for logging (M3). Pure: every number here comes from DB rows or
 * parsed input, never from model text. Output is Telegram HTML, so user-provided text is escaped.
 */
import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../config/constants.js";
import { trainingDate } from "../domain/calendar.js";
import { classBreakdown } from "../logging/class-moves.js";
import { dateLabel, describeAction } from "../logging/describe.js";
import type { MemoryItem } from "../logging/memory.js";
import type { Pending } from "../logging/pending.js";
import { farOffLoadRef, farOffReps } from "../logging/policy.js";
import type {
  Candidate,
  EditLastInput,
  GroupSnapshot,
  LedgerResult,
  ResolvedEntry,
  ResolvedLog,
  StagedAction,
} from "../logging/types.js";
import type { ExerciseType, LoadBasis, Weekday } from "../plan-import/types.js";
import { cb } from "./callbacks.js";
import { day, esc } from "./format.js";
import { swapCardText } from "./plan-change-format.js";

export interface Button {
  text: string;
  data: string;
}
export type Keyboard = Button[][];
/** Telegram inline keyboard for a Keyboard (one row per inner array). */
export function inlineKeyboard(kb: Keyboard): InlineKeyboard {
  const k = new InlineKeyboard();
  kb.forEach((row, i) => {
    for (const b of row) k.text(b.text, b.data);
    if (i < kb.length - 1) k.row();
  });
  return k;
}

export interface Message {
  text: string;
  keyboard: Keyboard;
}

export const HELP_TEXT = [
  "I'm your workout bot.",
  "Commands:",
  "/today — today's session",
  "/next — the next exercise to do",
  "/skip — skip an exercise or today's session",
  "/session — a specific day, e.g. /session mon or /session 26/10",
  "/week — this week",
  "/short — today's session when you are short on time",
  "/readiness — how you feel today",
  "/bw — log your bodyweight, e.g. /bw 78.5",
  "/class — log Thursday's class",
  "/swap — swap an exercise, e.g. /swap face pulls for band pull-aparts",
  "/plan — week, phases and next deload",
  "/history — last sessions of an exercise, e.g. /history squat",
  "/undo — remove your last log",
  "/memory — what I remember about you",
  "/help — this message",
  "",
  "Just tell me what you did, for example:",
  "• 3x8 squat 60 rir 2",
  "• bench 2x6 55",
  "• no it was 57.5",
  "• I skipped Bulgarian today",
  "• undo that",
  "",
  "You can also send a voice note, or a photo of the class board.",
  "",
  "Or ask me, for example:",
  "• what did I squat last week?",
  "• alternative to dips?",
  "• slept badly",
  "• I'm 78.5 kg today",
  "• class was heavy on legs",
  "• red band is 15 kg",
  "• what should I squat today?",
  "• show me Monday's session",
].join("\n");

export const TEXT_ONLY = "I can read text, voice notes and class board photos.";
export const VOICE_NOT_CONFIGURED = "Voice isn't configured yet. Text still works.";
export const VOICE_TOO_LONG = "That voice note is too long. Please keep it under 2 minutes.";
export const VOICE_BUDGET = "Voice budget reached. Text still works.";
export const VOICE_BLANK = "I couldn't hear that. Please try again or type it.";
export const VOICE_FAILED = "Sorry, I couldn't transcribe that. Please try again or type it.";
export const BOARD_UNREADABLE =
  "I couldn't read a class board in that photo. Please type or say the class instead.";
export const PHOTO_FAILED = "Sorry, I couldn't read that photo. Please try again.";
export const UNKNOWN_COMMAND = "I don't know that command. Try /help.";
export const NO_AI_KEY = "AI isn't configured yet. Commands still work.";
export const BUDGET_REACHED = "AI budget reached. Commands still work.";
export const NUMBER_GUARD_FALLBACK =
  "I can't answer that reliably — try /history, /session or /plan.";
export const DIDNT_GET_IT = "Sorry, I didn't get that. Try /help.";
export const EXPIRED = "This expired, nothing saved.";
export const REPLACED = "Replaced by a newer request.";
export const STALE = "That log no longer exists, nothing changed.";
export const MEMORY_EMPTY = "I don't know anything about you yet.";

// ---------------------------------------------------------------------------
// Numbers and places

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
};
const WEEKDAY_LONG: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
};

function dayMonth(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).setLocale("en").toFormat("d LLL");
}

export type Place =
  | { kind: "today"; weekday: Weekday; week: number }
  | { kind: "makeup"; weekday: Weekday; date: string }
  | { kind: "extra" };

export function placeLabel(p: Place): string {
  switch (p.kind) {
    case "today":
      return `${WEEKDAY_SHORT[p.weekday]} W${p.week}`;
    case "makeup":
      return `${WEEKDAY_LONG[p.weekday]}'s session (${dayMonth(p.date)})`;
    case "extra":
      return "extra";
  }
}

// ---------------------------------------------------------------------------
// One exercise line

export interface LineView {
  name: string;
  type: ExerciseType;
  loadBasis: LoadBasis | null;
  hspuStep: string | null;
  entries: ResolvedEntry[];
  place: Place | null;
}

export interface EchoView extends LineView {
  groupId: number;
  needsClean: boolean;
  /** The planned item has an RIR target. */
  hasRirTarget: boolean;
}

export function viewFromResolved(r: ResolvedLog): LineView {
  const p = r.plannedItem;
  let place: Place = { kind: "extra" };
  if (p && r.match === "today") place = { kind: "today", weekday: p.weekday, week: p.week };
  else if (p && r.match === "makeup") {
    place = { kind: "makeup", weekday: p.weekday, date: r.sessionDate };
  }
  return {
    name: r.exercise.name,
    type: r.exercise.type,
    loadBasis: r.exercise.loadBasis,
    hspuStep: r.hspuStep?.name ?? null,
    entries: r.entries,
    place,
  };
}

export function viewFromSnapshot(s: GroupSnapshot): LineView {
  return {
    name: s.exercise.name,
    type: s.exercise.type,
    loadBasis: s.exercise.loadBasis,
    hspuStep: s.hspuStep?.name ?? null,
    entries: s.entries,
    place: null,
  };
}

const same = (xs: unknown[]) => xs.every((x) => x === xs[0]);

/** "60 kg", "60/60/57.5 kg", "12.5 kg per hand". */
function numbersText(values: (number | null)[], unit: string, suffix = ""): string | null {
  if (values.every((v) => v === null)) return null;
  const parts = values.map((v) => (v === null ? "–" : fmt(v)));
  return `${same(parts) ? parts[0] : parts.join("/")} ${unit}${suffix}`;
}

function bodyweightTokens(entries: ResolvedEntry[]): string {
  const tokens = entries.map((e) =>
    (e.addedKg ?? 0) > 0
      ? `+${fmt(e.addedKg as number)} kg`
      : e.band
        ? `${e.band} band`
        : (e.assistKg ?? 0) > 0
          ? `${fmt(e.assistKg as number)} kg assist`
          : "bodyweight",
  );
  return same(tokens) ? (tokens[0] as string) : tokens.join(" / ");
}

function weightText(v: LineView): string | null {
  if (v.type === "bodyweight_plus") return bodyweightTokens(v.entries);
  return numbersText(
    v.entries.map((e) => e.loadKg),
    "kg",
    v.loadBasis === "per_hand" ? " per hand" : "",
  );
}

/** "3 × 8 · 60 kg", or "8, 8, 6 reps · 60/60/57.5 kg" when the sets differ. */
export function setsText(v: LineView): string {
  const es = v.entries;
  const n = es.length;
  const reps = es.map((e) => e.reps);
  const dur = numbersText(
    es.map((e) => e.durationS),
    "s",
  );
  const dist = numbersText(
    es.map((e) => e.distanceM),
    "m",
  );
  const weight = weightText(v);
  const uniform =
    same(reps) &&
    same(es.map((e) => e.durationS)) &&
    same(es.map((e) => e.distanceM)) &&
    same(es.map((e) => e.loadKg)) &&
    same(es.map((e) => `${e.addedKg}|${e.assistKg}|${e.band}`));

  const out: string[] = [];
  if (uniform) {
    if (reps[0] !== null && reps[0] !== undefined) out.push(`${n} × ${reps[0]}`);
    else if (dur) out.push(`${n} × ${dur}`);
    else if (dist) out.push(`${n} × ${dist}`);
    else out.push(`${n} set${n === 1 ? "" : "s"}`);
    if (reps[0] !== null && reps[0] !== undefined) {
      if (dur) out.push(dur);
      if (dist) out.push(dist);
    } else if (dur && dist) out.push(dist);
  } else {
    out.push(reps.every((r) => r !== null) ? `${reps.join(", ")} reps` : `${n} sets`);
    if (dur) out.push(dur);
    if (dist) out.push(dist);
  }
  if (weight) out.push(weight);
  return out.join(" · ");
}

function rirText(entries: ResolvedEntry[]): string | null {
  const last = [...entries].reverse().find((e) => e.rir !== null);
  return last ? `RIR ${last.rirPlus ? "4+" : last.rir}` : null;
}

function nameText(v: LineView): string {
  return v.hspuStep ? `${esc(v.name)} (${esc(v.hspuStep)})` : esc(v.name);
}

/** "Squat — 3 × 8 · 60 kg · RIR 2 · Tue W5". */
export function lineText(v: LineView): string {
  const parts = [setsText(v), rirText(v.entries), v.place ? placeLabel(v.place) : null];
  return `${nameText(v)} — ${parts.filter(Boolean).join(" · ")}`;
}

/** "Squat 3 × 8 · 60 kg": no RIR and no place, for deletes. */
export function plainLineText(v: LineView): string {
  return `${nameText(v)} ${setsText(v)}`;
}

// ---------------------------------------------------------------------------
// Echo after a save

const RIR_TYPES: ExerciseType[] = ["weighted", "bodyweight_plus", "skill_ladder"];

export function echoMessage(v: EchoView): Message {
  const keyboard: Keyboard = [[{ text: "Undo", data: cb.undoGroup(v.groupId) }]];
  const lines = [`✓ ${lineText(v)}`];
  const last = [...v.entries].sort((a, b) => b.setIndex - a.setIndex)[0];
  if (last && last.rir === null && (v.hasRirTarget || RIR_TYPES.includes(v.type))) {
    lines.push("RIR on the last set?");
    keyboard.push(
      [0, 1, 2, 3, 4].map((n) => ({
        text: n === 4 ? "4+" : String(n),
        data: cb.rir(v.groupId, n),
      })),
    );
  }
  if (v.needsClean && v.entries.some((e) => e.clean === null)) {
    lines.push("Clean reps?");
    keyboard.push([
      { text: "Clean ✓", data: cb.clean(v.groupId, true) },
      { text: "Not clean", data: cb.clean(v.groupId, false) },
    ]);
  }
  return { text: lines.join("\n"), keyboard };
}

export function removedText(s: GroupSnapshot): string {
  return `Removed: ${plainLineText(viewFromSnapshot(s))}`;
}

// ---------------------------------------------------------------------------
// Edits

function setsLabel(indexes: number[]): string {
  const sorted = [...indexes].sort((a, b) => a - b);
  if (sorted.length === 1) return `set ${sorted[0]}`;
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;
  if (last - first + 1 === sorted.length) return `sets ${first}–${last}`;
  return `sets ${sorted.join(", ")}`;
}

function distinct(values: (string | null)[]): string {
  const uniq = [...new Set(values.map((v) => v ?? "–"))];
  return uniq.join("/");
}

type EditAction = Extract<StagedAction, { kind: "edit_group" }>;

/** "Bench sets 1–2 55 → 57.5 kg" */
export function editLine(a: EditAction): string {
  const before = a.before.entries.filter((e) => a.setIndexes.includes(e.setIndex));
  const after = a.after.entries.filter((e) => a.setIndexes.includes(e.setIndex));
  const changes: string[] = [];
  const field = (
    pick: (e: ResolvedEntry) => string | null,
    render: (b: string, a: string) => string,
  ) => {
    const b = before.map(pick);
    const af = after.map(pick);
    if (b.join("|") === af.join("|")) return;
    changes.push(render(distinct(b), distinct(af)));
  };
  const num = (n: number | null) => (n === null ? null : fmt(n));
  field(
    (e) => num(e.reps),
    (b, n) => `${b} → ${n} reps`,
  );
  field(
    (e) => num(e.loadKg),
    (b, n) => `${b} → ${n} kg`,
  );
  field(
    (e) => num(e.addedKg ?? 0),
    (b, n) => `added ${b} → ${n} kg`,
  );
  field(
    (e) => num(e.assistKg ?? 0),
    (b, n) => `assist ${b} → ${n} kg`,
  );
  field(
    (e) => e.band,
    (b, n) => `band ${b} → ${n}`,
  );
  field(
    (e) => num(e.durationS),
    (b, n) => `${b} → ${n} s`,
  );
  field(
    (e) => num(e.distanceM),
    (b, n) => `${b} → ${n} m`,
  );
  field(
    (e) => (e.rir === null ? null : e.rirPlus ? "4+" : String(e.rir)),
    (b, n) => `RIR ${b} → ${n}`,
  );
  field(
    (e) => (e.clean === null ? null : e.clean ? "clean" : "not clean"),
    (b, n) => `${b} → ${n}`,
  );
  if (a.before.hspuStep?.slug !== a.after.hspuStep?.slug) {
    changes.push(`step ${a.before.hspuStep?.name ?? "–"} → ${a.after.hspuStep?.name ?? "–"}`);
  }
  if ((a.input as EditLastInput).changes.note !== undefined) changes.push("note updated");

  const name =
    a.before.exercise.id === a.after.exercise.id
      ? esc(a.after.exercise.name)
      : `${esc(a.before.exercise.name)} → ${esc(a.after.exercise.name)}`;
  const where = setsLabel(a.setIndexes);
  return `${name} ${where}${changes.length ? ` ${esc(changes.join(", "))}` : " updated"}`;
}

export function editEchoMessage(a: EditAction, sourceKey: string, index: number): Message {
  return {
    text: `Changed: ${editLine(a)}`,
    keyboard: [[{ text: "Undo", data: cb.undoEdit(sourceKey, index) }]],
  };
}

// ---------------------------------------------------------------------------
// Confirm and clarify cards

const humanField = (f: string) => f.replace(/_kg$/, "").replaceAll("_", " ");
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Plain-English reasons, built from the actions so every number is the parsed one. */
export function reasonPhrases(actions: StagedAction[], reasons: string[]): string[] {
  const logs = actions.filter(
    (a): a is Extract<StagedAction, { kind: "log_sets" }> => a.kind === "log_sets",
  );
  const out: string[] = [];
  for (const r of reasons) {
    switch (r) {
      case "multiple_writes":
        out.push("more than one change");
        break;
      case "not_in_today":
        out.push("not in today's session");
        break;
      case "makeup":
        for (const l of logs) {
          const day = l.resolved.plannedItem?.weekday;
          if (l.resolved.match === "makeup" && day) {
            out.push(placeLabel({ kind: "makeup", weekday: day, date: l.resolved.sessionDate }));
          }
        }
        break;
      case "missing_field": {
        const missing = unique(logs.flatMap((l) => l.resolved.missingFields.map(humanField)));
        if (missing.length) out.push(`missing: ${missing.join(", ")}`);
        break;
      }
      case "guessed": {
        const guessed = unique([
          ...logs.flatMap((l) => l.resolved.guessedFields),
          ...actions.flatMap((a) => (a.kind === "edit_group" ? a.input.guessed_fields : [])),
        ]).map(humanField);
        const plural = guessed.length > 1 || guessed[0]?.endsWith("s");
        if (guessed.length) out.push(`${guessed.join(", ")} ${plural ? "were" : "was"} guessed`);
        break;
      }
      case "class_moves":
        out.push("class report");
        break;
      case "voice_input":
        out.push("from a voice note");
        break;
      case "partly_understood":
        out.push("part of your message couldn't be saved");
        break;
      case "model_flag":
        out.push("I wasn't sure");
        break;
      case "load_far_off":
        for (const a of actions) {
          const far = farOffLoadRef(a);
          if (far) {
            out.push(
              far.source === "suggested"
                ? `far from the suggestion: ${fmt(far.load)} kg vs ${fmt(far.ref)} kg suggested`
                : `far from last time: ${fmt(far.load)} kg vs ${fmt(far.ref)} kg last time`,
            );
          }
        }
        break;
      case "reps_far_off":
        for (const a of actions) {
          const reps = farOffReps(a);
          if (reps !== null) out.push(`reps look high: ${reps}`);
        }
        break;
      case "memory":
        out.push("new memory item");
        break;
      case "equipment":
        out.push("this changes your equipment");
        break;
      case "plan_change":
        out.push("this changes your plan");
        break;
      case "skip_primary":
        out.push("skipping a PRIMARY item");
        break;
      case "skip_ambiguous":
        out.push("more than one planned item matches");
        break;
      case "skip_session":
        out.push("skipping the whole session");
        break;
      default:
        break; // "delete" needs no explanation
    }
  }
  return unique(out);
}

/** Under a "Remove this?" header a removal needs no "Remove" of its own. */
function actionLine(a: StagedAction, underRemoveHeader = false, today?: string): string {
  switch (a.kind) {
    case "log_sets":
      return lineText(viewFromResolved(a.resolved));
    case "edit_group":
      return `Change ${editLine(a)}`;
    case "delete_group":
      return `${underRemoveHeader ? "" : "Remove "}${plainLineText(viewFromSnapshot(a.snapshot))}`;
    case "clarify_exercise":
      return `Unclear exercise "${esc(a.said)}"`;
    case "save_memory":
      return `Remember (${a.input.kind}): ${esc(a.input.content)}`;
    case "swap":
      return swapCardText(a.resolved, today);
    case "set_band_kg":
      return `Set the ${esc(a.input.colour)} band to ${fmt(a.input.kg)} kg of assistance${
        a.previousKg !== null ? ` (was ${fmt(a.previousKg)} kg)` : ""
      }`;
    case "log_readiness":
    case "log_bodyweight":
    case "log_class":
      return esc(describeAction(a));
    case "skip_items": {
      const names = a.items.map((i) => esc(i.planName)).join(", ");
      if (a.whole) return `Whole session (${dateLabel(a.sessionDate)}): ${names}`;
      return a.items
        .map((i) => `${esc(i.planName)}${i.priority === "PRIMARY" ? " (PRIMARY)" : ""}`)
        .join(", ");
    }
  }
}

/** One-line summary of a request, used in the "Replaces: …" line. */
export function summarize(actions: StagedAction[]): string {
  return actions.map(describeAction).join("; ");
}

/** The card's new text after ❌: what was dropped, so the chat still shows it. */
export function cancelledText(actions: StagedAction[]): string {
  const dropped = actions.filter((a) => a.kind !== "clarify_exercise");
  return dropped.length
    ? `Cancelled, nothing saved: ${esc(summarize(dropped))}`
    : "Cancelled, nothing saved.";
}

/** The card's final text once its request expired unanswered. */
export function expiredText(actions: StagedAction[]): string {
  const dropped = actions.filter((a) => a.kind !== "clarify_exercise");
  return dropped.length
    ? `Expired, nothing saved: ${esc(summarize(dropped))}`
    : "Expired, nothing saved.";
}

/** The old card's text once a newer request replaced it. */
export function replacedText(actions: StagedAction[]): string {
  const dropped = actions.filter((a) => a.kind !== "clarify_exercise");
  return dropped.length ? `${REPLACED.replace(/\.$/, "")}: ${esc(summarize(dropped))}` : REPLACED;
}

/** Telegram shows Markdown literally: drop the markers the model may still use. */
export function stripMarkdown(text: string): string {
  return text
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replaceAll("`", "")
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
}

const HEARD_MAX = 300;

/** The "🎤 heard:" line (capped, escaped) and a blank line, first on every voice-origin card. */
export function heardLine(heard: string): string {
  const chars = Array.from(heard);
  const text = chars.length > HEARD_MAX ? `${chars.slice(0, HEARD_MAX).join("")}…` : heard;
  return `🎤 heard: ${esc(text)}`;
}

function pushHeard(lines: string[], heard: string | null | undefined): void {
  if (!heard) return;
  lines.push(heardLine(heard), "");
}

export function confirmCard(args: {
  id: number;
  kind: Pending["kind"];
  actions: StagedAction[];
  reasons: string[];
  /** Summary of an older request this one replaced. */
  replacedSummary?: string | null;
  /** Voice transcript or photo read-out, shown first. */
  heard?: string | null;
  /** Training date for relative wording in plan-change lines; defaults to the real clock. */
  today?: string;
}): Message {
  const isDelete = args.kind === "delete";
  const lines: string[] = [];
  pushHeard(lines, args.heard);
  if (args.replacedSummary) {
    lines.push(`Replaces: ${esc(args.replacedSummary)}`, "");
  }
  const isSkip = args.actions.every((a) => a.kind === "skip_items");
  lines.push(isDelete ? "Remove this?" : isSkip ? "Skip this?" : "Save this?");
  for (const a of args.actions) lines.push(`• ${actionLine(a, isDelete, args.today)}`);
  const why = reasonPhrases(args.actions, args.reasons);
  if (why.length) lines.push("", `Why I'm asking: ${esc(why.join("; "))}`);
  const keyboard: Button[] = [{ text: "✅", data: cb.pending(args.id, "ok") }];
  if (!isDelete) keyboard.push({ text: "✏️", data: cb.pending(args.id, "ed") });
  keyboard.push({ text: "❌", data: cb.pending(args.id, "no") });
  return { text: lines.join("\n"), keyboard: [keyboard] };
}

/** The three heavy-group toggles of the class cards (mask bits: pull 1, push 2, legs 4). */
export const CLASS_HEAVY_GROUPS = [
  { bit: 1, key: "pull", label: "Pull" },
  { bit: 2, key: "push", label: "Push" },
  { bit: 4, key: "legs", label: "Legs" },
] as const;

export const maskToGroups = (mask: number): ("pull" | "push" | "legs")[] =>
  CLASS_HEAVY_GROUPS.filter((g) => (mask & g.bit) !== 0).map((g) => g.key);

export const groupsToMask = (groups: readonly string[]): number =>
  CLASS_HEAVY_GROUPS.reduce((m, g) => (groups.includes(g.key) ? m | g.bit : m), 0);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 moves, 6 sets", "2 moves, 6+ sets" (some moves without sets) or "2 moves" (none had sets). */
export function classRowText(row: ReturnType<typeof classBreakdown>[number]): string {
  const moves = plural(row.moves, "move");
  if (row.setMoves === 0) return moves;
  return row.setMoves === row.moves
    ? `${moves}, ${plural(row.sets, "set")}`
    : `${moves}, ${row.sets}+ sets`;
}

/** A pending class log with moves: breakdown per group, heavy toggles (nothing ticked until the user taps), Save. */
export function classMovesCard(args: {
  id: number;
  action: Extract<StagedAction, { kind: "log_class" }>;
  mask: number;
  heard?: string | null;
  replacedSummary?: string | null;
}): Message {
  const { id, action, mask } = args;
  const lines: string[] = [];
  pushHeard(lines, args.heard);
  if (args.replacedSummary) lines.push(`Replaces: ${esc(args.replacedSummary)}`, "");
  lines.push(`Thursday class (${day(action.date, "ccc d LLL")}):`);
  for (const row of classBreakdown(action.input.moves ?? [])) {
    const label = row.group.charAt(0).toUpperCase() + row.group.slice(1);
    lines.push(`${label}: ${classRowText(row)}`);
  }
  const picked = maskToGroups(mask);
  lines.push(
    "",
    "Which parts were heavy?",
    `Selected: ${picked.length ? picked.join(", ") : "none (= not heavy)"}. Tap to change, then Save.`,
  );
  return {
    text: lines.join("\n"),
    keyboard: [
      CLASS_HEAVY_GROUPS.map((g) => ({
        text: `${(mask & g.bit) !== 0 ? "✓ " : ""}${g.label}`,
        data: cb.classMoves(id, mask ^ g.bit),
      })),
      [
        { text: "Not heavy", data: cb.classMovesSave(id, 0) },
        { text: "Save", data: cb.classMovesSave(id, mask) },
        { text: "❌", data: cb.pending(id, "no") },
      ],
    ],
  };
}

export function clarifyCard(args: {
  id: number;
  /** Position of the clarify action in the request, carried by its buttons. */
  actionIndex: number;
  said: string;
  candidates: Candidate[];
  replacedSummary?: string | null;
  partlyUnderstood?: boolean;
  heard?: string | null;
}): Message {
  const lines: string[] = [];
  pushHeard(lines, args.heard);
  if (args.replacedSummary) {
    lines.push(`Replaces: ${esc(args.replacedSummary)}`, "");
  }
  lines.push(
    args.candidates.length
      ? `Which exercise is "${esc(args.said)}"?`
      : `I couldn't find an exercise called "${esc(args.said)}".`,
  );
  if (args.partlyUnderstood) lines.push("Part of your message couldn't be saved.");
  const keyboard: Keyboard = args.candidates.map((c, i) => [
    { text: c.name, data: cb.exercise(args.id, i, args.actionIndex) },
  ]);
  keyboard.push([{ text: "❌", data: cb.pending(args.id, "no") }]);
  return { text: lines.join("\n"), keyboard };
}

/** "Remove Squat 3 × 8 · 60 kg (today 18:42)?" for /undo. */
export function deleteQuestion(s: GroupSnapshot, id: number, now: Date): Message {
  const at = DateTime.fromISO(s.performedAt, { zone: APP_TIMEZONE }).setLocale("en");
  const today = DateTime.fromJSDate(now, { zone: APP_TIMEZONE });
  const logged = at.hasSame(today, "day")
    ? `today ${at.toFormat("HH:mm")}`
    : at.toFormat("ccc d LLL HH:mm");
  // A make-up belongs to an earlier session than the day it was logged on.
  const when =
    trainingDate(new Date(s.performedAt)) === s.sessionDate
      ? logged
      : `${dateLabel(s.sessionDate)}, logged ${logged}`;
  return {
    text: `Remove ${plainLineText(viewFromSnapshot(s))} (${when})?`,
    keyboard: [
      [
        { text: "✅", data: cb.pending(id, "ok") },
        { text: "❌", data: cb.pending(id, "no") },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Memory

export function memoryList(items: MemoryItem[]): Message {
  if (items.length === 0) return { text: MEMORY_EMPTY, keyboard: [] };
  return {
    text: ["Here is what I remember:", ...items.map((i) => `• ${esc(i.content)}`)].join("\n"),
    keyboard: items.map((i) => [{ text: `🗑 ${i.content.slice(0, 40)}`, data: cb.memory(i.id) }]),
  };
}

/** "Saved: left shoulder sensitive on dips" with an Undo that deactivates the item. */
export function memorySaved(content: string, memoryId: number): Message {
  return {
    text: `Saved: ${esc(content)}`,
    keyboard: [[{ text: "Undo", data: cb.memory(memoryId) }]],
  };
}

/** Asked once, the first time a band colour with no kg mapping shows up in a saved log. */
export function bandQuestion(colour: string): Message {
  const c = esc(colour);
  return {
    text: `How many kg is the ${c} band? Send e.g. "${c} band 15 kg".`,
    keyboard: [],
  };
}

const READINESS_WORDS = {
  bad_sleep: "bad sleep",
  sore: "sore muscles",
  exhausted: "exhausted",
  good: "feeling great",
  tired: "tired",
  ok: "feeling ok",
  strong: "feeling strong",
} as const;

/** Echo of a direct readiness / bodyweight / class write, with an Undo that reverts it. */
export function directWriteSaved(
  result: Extract<LedgerResult, { kind: "readiness" | "bodyweight" | "class" }>,
  sourceKey: string,
  index: number,
): Message {
  const undo = [[{ text: "Undo", data: cb.undoWrite(sourceKey, index) }]];
  switch (result.kind) {
    case "readiness":
      return {
        text: `Noted: ${READINESS_WORDS[result.signal]}. I'll go easier if it adds up.`,
        keyboard: undo,
      };
    case "bodyweight":
      return { text: `✓ Bodyweight ${fmt(result.kg)} kg`, keyboard: undo };
    case "class":
      return {
        text: `✓ Thursday class: ${
          result.moveCount !== undefined
            ? `${result.moveCount} ${result.moveCount === 1 ? "move" : "moves"}; `
            : ""
        }${
          result.heavyGroups.length
            ? `heavy ${result.heavyGroups.map((g) => g.toUpperCase()).join(", ")}`
            : "not heavy"
        }`,
        keyboard: undo,
      };
  }
}

export function bandSaved(colour: string, kg: number): Message {
  return { text: `Saved: ${esc(colour)} band = ${fmt(kg)} kg`, keyboard: [] };
}

export function aliasSaved(said: string, exerciseName: string, memoryId: number): Message {
  return {
    text: `Saved: "${esc(said)}" = ${esc(exerciseName)}`,
    keyboard: [[{ text: "Undo", data: cb.memory(memoryId) }]],
  };
}
