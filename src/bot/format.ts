import { DateTime } from "luxon";
import type { FallbackPrescription } from "../plan-import/types.js";
import type {
  HeavyGroup,
  ItemStatus,
  Session,
  SessionItem,
  WeekDay,
  WeekOverview,
} from "./session.js";

/** Telegram's hard limit for one text message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

const RAW_MAX = 60;
const LENGTH_GUARD = 4000;
const NOT_RAW_TAGS = new Set(["warmup", "mobility", "class", "recovery"]);
const STATUS_ICON: Record<ItemStatus, string> = {
  planned: "",
  done: "✓ ",
  skipped: "⏭ ",
  modified: "✎ ",
};
/** Friday: which item tags a heavy Thursday group touches. */
const HEAVY_TAGS: Record<HeavyGroup, string[]> = {
  pull: ["row"],
  push: ["horizontal_press"],
  legs: ["squat", "unilateral_leg"],
};
const WEEKDAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri" } as const;

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function day(date: string, fmt: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).setLocale("en").toFormat(fmt);
}

function range(min: number, max: number): string {
  return min === max ? `${min}` : `${min}–${max}`;
}

/** Cuts at a " · " or word boundary so the result (with "…") is at most `max` characters. */
function shorten(text: string, max = RAW_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max - 1);
  const dot = head.lastIndexOf(" · ");
  const space = head.lastIndexOf(" ");
  // Cut exactly at a boundary when the next char starts a new word.
  const atBoundary = clean[max - 1] === " " ? head.length : -1;
  const cut = dot > 0 ? dot : atBoundary > 0 ? atBoundary : space > 0 ? space : head.length;
  return `${head.slice(0, cut).trimEnd()}…`;
}

/** Hard guard so one reply never exceeds Telegram's limit. */
export function guardLength(text: string, max = LENGTH_GUARD): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > 0 ? cut.slice(0, nl) : cut).trimEnd()}…`;
}

function minutes(sMin: number, sMax: number): string | null {
  if (sMin % 60 !== 0 || sMax % 60 !== 0) return null;
  return `${range(sMin / 60, sMax / 60)} min`;
}

function setsReps(s: { sets: number; reps_min: number; reps_max: number }): string {
  return `${s.sets} × ${range(s.reps_min, s.reps_max)}`;
}

const VARIANT_LABEL: Record<string, string> = {
  weighted: "weighted",
  deload: "deload",
  weighted_deload: "weighted, deload",
  test: "test",
};

function itemName(item: SessionItem): string {
  const names = item.options.map((o) => o.name);
  if (names.length > 1) {
    return [names[0], ...names.slice(1).map((n) => n.charAt(0).toLowerCase() + n.slice(1))].join(
      " or ",
    );
  }
  const base = names[0] ?? item.planName.replace(/\*+$/, "");
  if (item.options[0]?.slug === "hspu") {
    return `${base} — ${item.hspuStep ?? "your current step"}`;
  }
  const variant = item.variantLabel
    ? (VARIANT_LABEL[item.variantLabel] ?? item.variantLabel)
    : null;
  return variant ? `${base} (${variant})` : base;
}

function prescription(item: SessionItem): string {
  if (item.hiit)
    return `${item.hiit.rounds} × ${item.hiit.work_s}s hard / ${item.hiit.rest_s}s easy`;
  const rawOnly = item.tags.some((t) => NOT_RAW_TAGS.has(t) || t === "skill_practice");
  if (!rawOnly) {
    if (item.setsMin != null && item.setsMax != null) {
      const sets = range(item.setsMin, item.setsMax);
      if (item.repsMin != null && item.repsMax != null) {
        const side = item.perSide ? (item.tags.includes("unilateral_leg") ? "/leg" : "/side") : "";
        return `${sets} × ${range(item.repsMin, item.repsMax)}${side}`;
      }
      if (item.durationSMin != null && item.durationSMax != null) {
        return `${sets} × ${range(item.durationSMin, item.durationSMax)}s`;
      }
    } else if (item.durationSMin != null && item.durationSMax != null) {
      const m = minutes(item.durationSMin, item.durationSMax);
      if (m) return m;
    }
  }
  return shorten(item.prescriptionRaw);
}

export function itemLine(item: SessionItem, n: number): string {
  let line = `${n}. ${STATUS_ICON[item.status]}<b>${esc(itemName(item))}</b> — ${esc(prescription(item))}`;
  if (item.rirMin != null && item.rirMax != null)
    line += ` · RIR ${range(item.rirMin, item.rirMax)}`;
  if (item.modifiers.includes("light")) line += " · light";
  if (item.modifiers.includes("easy") && item.setsMin != null) line += " · easy";
  if (item.modifiers.includes("optional")) line += " (optional)";
  return line;
}

export function fallbackLine(fb: FallbackPrescription): string {
  return `Not at 6 clean reps yet → bodyweight ${setsReps(fb.then)} (or assisted ${setsReps(fb.else)})`;
}

export function extraLine(extra: SessionItem): string {
  const raw = (extra.extrasRaw ?? extra.prescriptionRaw).replace(/^\s*\+\s*/, "");
  return `+ ${raw.replace(/\bBW\b/g, "bodyweight")}`;
}

function badge(isDeload: boolean, isTest: boolean): string | null {
  if (isDeload) return "🟢 Deload week: keep it easy.";
  if (isTest) return "🎯 Test week.";
  return null;
}

function thursdayLine(thursday: NonNullable<Extract<Session, { kind: "session" }>["thursday"]>) {
  if (thursday === "not_reported") return "Thursday class: not reported";
  if (thursday.heavy.length === 0) return "Thursday class: not heavy";
  return `Thursday class: heavy ${thursday.heavy.map((g) => g.toUpperCase()).join(", ")}`;
}

function estimate(items: SessionItem[]): string | null {
  let min = 0;
  let max = 0;
  let any = false;
  for (const i of items) {
    if (i.timeMinMin == null && i.timeMinMax == null) continue;
    any = true;
    min += i.timeMinMin ?? i.timeMinMax ?? 0;
    max += i.timeMinMax ?? i.timeMinMin ?? 0;
  }
  return any ? `≈ ${range(min, max)} min` : null;
}

export function formatToday(session: Extract<Session, { kind: "session" }>): string {
  const lines: string[] = [
    `<b>Week ${session.week} · ${esc(session.phase)}</b> · ${day(session.date, "ccc d LLL")} — ${esc(session.focus)}`,
  ];
  const b = badge(session.isDeload, session.isTest);
  if (b) lines.push(b);
  if (session.thursday !== undefined) lines.push(esc(thursdayLine(session.thursday)));
  lines.push("");

  const heavy =
    session.thursday && session.thursday !== "not_reported" ? session.thursday.heavy : [];
  const heavyTags = new Set(heavy.flatMap((g) => HEAVY_TAGS[g]));
  const mains = session.items.filter((i) => i.subItem === 0);
  mains.forEach((item, idx) => {
    lines.push(itemLine(item, idx + 1));
    if (item.fallback) lines.push(`   <i>${esc(fallbackLine(item.fallback))}</i>`);
    for (const extra of session.items.filter(
      (e) => e.subItem > 0 && e.itemOrder === item.itemOrder,
    )) {
      lines.push(`   ${esc(extraLine(extra))}`);
    }
    if (item.note && item.tags.some((t) => heavyTags.has(t))) {
      lines.push(`   ⚠️ ${esc(item.note)}`);
    }
  });

  const time = estimate(mains);
  if (time) lines.push("", time);
  return guardLength(lines.join("\n"));
}

export function formatRest(session: Extract<Session, { kind: "rest" }>): string {
  return `<b>Week ${session.week} · ${esc(session.phase)}</b> · ${day(session.date, "ccc d LLL")}\nRest day. Enjoy it. 😌`;
}

export function formatBeforeStart(startDate: string): string {
  return `The plan starts on ${day(startDate, "ccc d LLL")}.`;
}

export function formatFinished(): string {
  return "The 12-week plan is finished. 🎉 A new plan comes later.";
}

export function formatSession(session: Session): string {
  switch (session.kind) {
    case "before_start":
      return formatBeforeStart(session.startDate);
    case "finished":
      return formatFinished();
    case "rest":
      return formatRest(session);
    case "session":
      return formatToday(session);
  }
}

export function weekRange(startDate: string): string {
  const start = DateTime.fromISO(startDate, { zone: "utc" }).setLocale("en");
  const end = start.plus({ days: 6 });
  return start.month === end.month
    ? `${start.day}–${end.toFormat("d LLL")}`
    : `${start.toFormat("d LLL")} – ${end.toFormat("d LLL")}`;
}

function weekDayLine(d: WeekDay): string {
  let line = `${WEEKDAY_LABEL[d.weekday]} · ${esc(d.focus)} — ${d.done}/${d.total} done`;
  if (d.skipped > 0) line += ` · ${d.skipped} skipped`;
  if (d.modified > 0) line += ` · ${d.modified} changed`;
  return line;
}

export function formatWeek(week: WeekOverview): string {
  if (week.kind === "before_start") return formatBeforeStart(week.startDate);
  if (week.kind === "finished") return formatFinished();
  const lines = [`<b>Week ${week.week} · ${esc(week.phase)}</b> · ${weekRange(week.startDate)}`];
  const b = badge(week.isDeload, week.isTest);
  if (b) lines.push(b);
  lines.push("");
  for (const d of week.days) lines.push(weekDayLine(d));
  lines.push("Sat · rest", "Sun · rest");
  return guardLength(lines.join("\n"));
}
