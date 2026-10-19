import { DateTime } from "luxon";
import type { FallbackPrescription } from "../plan-import/types.js";
import type { AdviceItem, SessionAdvice } from "../progression/session-advice.js";
import {
  FRIDAY_ASK_CLASS,
  heavyGroupFor,
  type LabelContext,
  levelLines,
  loadText,
  SESSION_VIEW_LABELS,
  suggestionNotes,
} from "./progression-format.js";
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
export const HEAVY_TAGS: Record<HeavyGroup, string[]> = {
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

function itemName(item: SessionItem, hspuStepName?: string | null): string {
  const name = baseItemName(item, hspuStepName);
  return item.swappedFrom ? `${name} (instead of ${item.swappedFrom} today)` : name;
}

/** The item name /today shows, without a swap note. Also used by the /skip buttons. */
export function baseItemName(
  item: Pick<SessionItem, "options" | "planName" | "variantLabel"> & { hspuStep?: string | null },
  hspuStepName?: string | null,
): string {
  const names = item.options.map((o) => o.name);
  if (names.length > 1) {
    return [names[0], ...names.slice(1).map((n) => n.charAt(0).toLowerCase() + n.slice(1))].join(
      " or ",
    );
  }
  const base = names[0] ?? item.planName.replace(/\*+$/, "");
  if (item.options[0]?.slug === "hspu") {
    return `${base} — ${hspuStepName ?? item.hspuStep ?? "your current step"}`;
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

// ---------------------------------------------------------------------------
// Adjusted session (M5): suggested loads, labels, Friday / readiness changes

function sideSuffix(item: SessionItem): string {
  return item.perSide ? (item.tags.includes("unilateral_leg") ? "/leg" : "/side") : "";
}

function rawOnlyItem(item: SessionItem): boolean {
  return item.tags.some((t) => NOT_RAW_TAGS.has(t) || t === "skill_practice");
}

/** "3 × 6–8" / HIIT / plan text, after Friday, readiness and the suggestion. */
export function advisedPrescription(item: SessionItem, adv: AdviceItem): string {
  if (adv.hiit) return `${adv.hiit.rounds} × ${adv.hiit.work_s}s hard / ${adv.hiit.rest_s}s easy`;
  if (adv.hspu) return `${adv.hspu.sets} × ${range(adv.hspu.repsMin, adv.hspu.repsMax)}`;
  if (rawOnlyItem(item) || adv.pullup?.maxTestFirst) return prescription(item);
  const sug = Object.values(adv.suggestions).find((s) => s != null);
  const p = sug
    ? { sets: sug.sets, repsMin: sug.repsMin, repsMax: sug.repsMax }
    : adv.friday || adv.prescription?.sets != null
      ? adv.prescription
      : null;
  if (p && p.sets != null && p.repsMin != null && p.repsMax != null && sug) {
    return `${p.sets} × ${range(p.repsMin, p.repsMax)}${sideSuffix(item)}`;
  }
  if (adv.friday && p && p.sets != null && p.repsMin != null && p.repsMax != null) {
    return `${p.sets} × ${range(p.repsMin, p.repsMax)}${sideSuffix(item)}`;
  }
  return prescription(item);
}

export function fridayText(adv: AdviceItem, why: string): string | null {
  const f = adv.friday;
  if (!f || adv.hidden) return null;
  if (f.kind === "reduce") return `reduced to ${f.sets} × ${f.reps} (${why}) — or skip`;
  if (f.kind === "deload_reduce") return `1 easy set (${why}) — or skip`;
  if (f.kind === "offer_skip") return `can skip (${why})`;
  return null;
}

interface AdvisedCtx {
  advice: SessionAdvice;
  heavy: HeavyGroup[];
}

export function exerciseBySlug(advice: SessionAdvice, slug: string) {
  return Object.values(advice.exercises).find((e) => e.slug === slug);
}

function advisedLines(item: SessionItem, n: number, adv: AdviceItem, c: AdvisedCtx): string[] {
  const labelCtx: LabelContext = { bodyweightDate: c.advice.bodyweightDate };
  const heavyGroup = heavyGroupFor(item.tags, c.heavy, HEAVY_TAGS);
  const why = heavyGroup ? `heavy ${heavyGroup} Thursday` : "heavy Thursday";
  const perOption = item.options.map((o) => {
    const ex = exerciseBySlug(c.advice, o.slug);
    const sug = ex ? (adv.suggestions[ex.id] ?? null) : null;
    return {
      name: o.name,
      sug,
      load: ex && sug ? loadText(ex, sug) : null,
      notes: suggestionNotes(sug, labelCtx, SESSION_VIEW_LABELS),
    };
  });
  const multi = item.options.length > 1;
  const first = perOption.find((o) => o.sug != null) ?? perOption[0];

  let line = `${n}. ${STATUS_ICON[item.status]}<b>${esc(itemName(item, adv.hspuStep?.name))}</b> — ${esc(advisedPrescription(item, adv))}`;
  if (!multi && first?.load) line += ` · ${esc(first.load)}`;
  if (adv.hspuStep?.padHeight != null) line += ` · pad ${adv.hspuStep.padHeight}`;
  const sug = first?.sug;
  if (sug) line += ` · RIR ${range(sug.rirMin, sug.rirMax)}`;
  else if (adv.friday?.kind === "reduce") line += " · RIR 3–4";
  else if (item.rirMin != null && item.rirMax != null) {
    line += ` · RIR ${range(item.rirMin, item.rirMax)}`;
  }
  if (item.modifiers.includes("light")) line += " · light";
  if (item.modifiers.includes("easy") && item.setsMin != null) line += " · easy";
  if (item.modifiers.includes("optional") || adv.optional) line += " (optional)";

  const out = [line];
  if (multi) {
    for (const o of perOption.filter((p) => p.load !== null || p.notes.length > 0)) {
      const notes = o.notes.length ? ` (${o.notes.join("; ")})` : "";
      out.push(`   ${esc(o.name)}: ${esc(o.load ?? "–")}${esc(notes)}`);
    }
  } else if (first?.notes.length) {
    out.push(`   <i>${esc(first.notes.join(" · "))}</i>`);
  }
  const fri = fridayText(adv, why);
  if (fri) out.push(`   <i>${esc(fri)}</i>`);
  if (
    c.advice.level === "RED" &&
    item.tags.includes("skill_practice") &&
    adv.prescription?.sets != null
  ) {
    const rir =
      adv.prescription.rirMin != null && adv.prescription.rirMax != null
        ? ` · RIR ${range(adv.prescription.rirMin, adv.prescription.rirMax)}`
        : "";
    out.push(`   <i>easy volume today: ${adv.prescription.sets} sets${rir}</i>`);
  }
  const pp = adv.pullup;
  if (pp?.maxTestFirst) {
    out.push("   <i>Start with one max clean set (stop 1 rep before form breaks).</i>");
    if (pp.afterMaxTest) {
      const a = pp.afterMaxTest;
      out.push(
        `   <i>${esc(
          `Then bodyweight ${a.bw.sets} × ${range(a.bw.repsMin, a.bw.repsMax)} if you got ${a.thresholdReps}+ clean reps, else assisted ${a.assisted.sets} × ${range(a.assisted.repsMin, a.assisted.repsMax)}`,
        )}</i>`,
      );
    }
  }
  return out;
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

/**
 * One main item with its "+" extras, ready for /today and /next: the suggested load and notes when there is advice,
 * the plan text otherwise (also its fallback and the heavy-Thursday warning).
 */
export function itemBlock(
  item: SessionItem,
  n: number,
  extras: SessionItem[],
  advice: SessionAdvice | null | undefined,
  heavy: HeavyGroup[],
): string[] {
  const lines: string[] = [];
  const adv = advice?.items.get(item.plannedItemId);
  if (advice && adv) lines.push(...advisedLines(item, n, adv, { advice, heavy }));
  else lines.push(itemLine(item, n));
  // With advice the pull-up plan is already spelled out (gate, fallback or max test first).
  if (item.fallback && !adv?.pullup) lines.push(`   <i>${esc(fallbackLine(item.fallback))}</i>`);
  for (const extra of extras) {
    const eadv = advice?.items.get(extra.plannedItemId);
    let text = extraLine(extra);
    if (advice && eadv) {
      const ex = extra.options[0] ? exerciseBySlug(advice, extra.options[0].slug) : undefined;
      const sug = ex ? (eadv.suggestions[ex.id] ?? null) : null;
      const load = ex && sug ? loadText(ex, sug) : null;
      if (load) text += ` · ${load}`;
    }
    lines.push(`   ${esc(text)}`);
  }
  const heavyTags = new Set(heavy.flatMap((g) => HEAVY_TAGS[g]));
  if (!advice && item.note && item.tags.some((t) => heavyTags.has(t))) {
    lines.push(`   ⚠️ ${esc(item.note)}`);
  }
  return lines;
}

/** Items the readiness level, /short or a Friday skip took out of today's list. */
export function hiddenItemIds(advice: SessionAdvice | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!advice) return out;
  for (const [id, adv] of advice.items) if (adv.hidden) out.add(id);
  return out;
}

export function formatToday(
  session: Extract<Session, { kind: "session" }>,
  advice?: SessionAdvice | null,
  opts: { short?: boolean } = {},
): string {
  const lines: string[] = [
    `<b>Week ${session.week} · ${esc(session.phase)}</b> · ${day(session.date, "ccc d LLL")} — ${esc(session.focus)}${opts.short ? " · short" : ""}`,
  ];
  const b = badge(session.isDeload, session.isTest);
  if (b) lines.push(b);
  if (session.thursday !== undefined) {
    lines.push(advice?.askClassFirst ? esc(FRIDAY_ASK_CLASS) : esc(thursdayLine(session.thursday)));
  }
  if (advice) {
    for (const l of levelLines(advice.level, advice.levelKinds, {
      restDay: advice.restDaySuggested,
      classAdvice: advice.classAdvice,
    })) {
      lines.push(esc(l));
    }
  }
  lines.push("");

  const heavy =
    session.thursday && session.thursday !== "not_reported" ? session.thursday.heavy : [];
  const mains = session.items.filter((i) => i.subItem === 0);
  const hidden = hiddenItemIds(advice);
  const shown = mains.filter((i) => !hidden.has(i.plannedItemId));
  shown.forEach((item, idx) => {
    const extras = session.items.filter((e) => e.subItem > 0 && e.itemOrder === item.itemOrder);
    lines.push(...itemBlock(item, idx + 1, extras, advice, heavy));
  });
  const dropped = mains
    .filter((i) => hidden.has(i.plannedItemId))
    .map((i) => baseItemName(i))
    .filter((name, idx, all) => all.indexOf(name) === idx);
  if (dropped.length) lines.push("", `Dropped today: ${esc(dropped.join(", "))}`);

  const time = estimate(shown);
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
  return "The plan is finished.";
}

export function formatSession(
  session: Session,
  advice?: SessionAdvice | null,
  opts: { short?: boolean } = {},
): string {
  switch (session.kind) {
    case "before_start":
      return formatBeforeStart(session.startDate);
    case "finished":
      return formatFinished();
    case "rest":
      return formatRest(session);
    case "session":
      return formatToday(session, advice, opts);
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
