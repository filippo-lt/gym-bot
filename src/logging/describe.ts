/** Short plain-English descriptions, used for model previews and the prompt context. */
import { DateTime } from "luxon";
import type { GroupSnapshot, ResolvedEntry, StagedAction } from "./types.js";

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function dateLabel(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).setLocale("en").toFormat("ccc d LLL");
}

function same<T>(xs: T[]): boolean {
  return xs.every((x) => x === xs[0]);
}

/** e.g. "3 × 8 · 60 kg", "3 sets (8/8/6) · 60–65 kg", "+10 kg". */
export function describeEntries(entries: ResolvedEntry[]): string {
  if (entries.length === 0) return "no sets";
  const parts: string[] = [];
  const reps = entries.map((e) => e.reps);
  if (reps.every((r): r is number => r !== null)) {
    parts.push(
      same(reps) ? `${entries.length} × ${reps[0]}` : `${entries.length} sets (${reps.join("/")})`,
    );
  } else {
    parts.push(`${entries.length} set${entries.length === 1 ? "" : "s"}`);
  }
  const loads = entries.map((e) => e.loadKg).filter((x): x is number => x !== null);
  if (loads.length > 0) {
    const lo = Math.min(...loads);
    const hi = Math.max(...loads);
    parts.push(lo === hi ? `${fmt(lo)} kg` : `${fmt(lo)}–${fmt(hi)} kg`);
  }
  const added = entries.map((e) => e.addedKg ?? 0);
  const assist = entries.map((e) => e.assistKg ?? 0);
  if (Math.max(...added) > 0) parts.push(`+${fmt(Math.max(...added))} kg`);
  const bands = [...new Set(entries.map((e) => e.band).filter((b): b is string => !!b))];
  if (bands.length > 0) parts.push(`${bands.join("/")} band`);
  else if (Math.max(...assist) > 0) parts.push(`assist ${fmt(Math.max(...assist))} kg`);
  const durations = entries.map((e) => e.durationS).filter((x): x is number => x !== null);
  if (durations.length > 0) parts.push(`${fmt(Math.max(...durations))} s`);
  const dist = entries.map((e) => e.distanceM).filter((x): x is number => x !== null);
  if (dist.length > 0) parts.push(`${fmt(Math.max(...dist))} m`);
  return parts.join(" · ");
}

export function describeAction(a: StagedAction): string {
  switch (a.kind) {
    case "log_sets":
      return `${a.resolved.exercise.name} ${describeEntries(a.resolved.entries)}`;
    case "edit_group":
      return `edit ${a.after.exercise.name}: ${describeEntries(a.after.entries)}`;
    case "delete_group":
      return `remove ${a.snapshot.exercise.name} ${describeEntries(a.snapshot.entries)}`;
    case "clarify_exercise":
      return `unclear exercise "${a.said}"`;
    case "save_memory":
      return `remember (${a.input.kind}): ${a.input.content}`;
    case "swap":
      return `swap ${a.resolved.from.name} for ${a.resolved.to.name}`;
    case "set_band_kg":
      return `${a.input.colour} band = ${fmt(a.input.kg)} kg`;
    case "log_readiness":
      return `readiness: ${a.input.signal.replace("_", " ")}`;
    case "log_bodyweight":
      return `bodyweight ${fmt(a.input.kg)} kg`;
    case "log_class": {
      const heavy = a.input.heavy_groups ?? [];
      const heavyText = heavy.length ? `heavy ${heavy.join(", ")}` : "not heavy";
      const n = a.input.moves?.length;
      if (n === undefined) return `Thursday class: ${heavyText}`;
      return `Thursday class: ${n} ${n === 1 ? "move" : "moves"}; heavy: ${heavy.length ? heavy.join(", ") : "none"}`;
    }
    case "skip_items":
      return a.whole
        ? `skip the whole session (${dateLabel(a.sessionDate)})`
        : `skip ${a.items.map((i) => i.label ?? i.planName).join(", ")}`;
  }
}

/** A saved group in one plain line, e.g. "Squat 3 × 8 · 60 kg". */
export function describeSnapshot(s: GroupSnapshot): string {
  return `${s.exercise.name} ${describeEntries(s.entries)}`;
}
