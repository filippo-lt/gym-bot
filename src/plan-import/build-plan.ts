import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CATALOG,
  CATALOG_BY_SLUG,
  OR_PLAN_NAMES,
  PLAN_NAME_MAP,
  TEXT_OPTION_PLAN_NAMES,
} from "./exercise-catalog.js";
import { fallbackFor } from "./fallback.js";
import { type ParsedPrescription, parsePrescription } from "./parse-prescription.js";
import { computeRir } from "./rir.js";
import type {
  CatalogExercise,
  Equipment,
  HspuStep,
  Modifier,
  ParsedItem,
  ParsedPlan,
  ParsedWeek,
  ParseFlag,
  Priority,
  Tag,
  Weekday,
} from "./types.js";

const WEEKDAYS: [string, Weekday][] = [
  ["Monday", "mon"],
  ["Tuesday", "tue"],
  ["Wednesday", "wed"],
  ["Thursday", "thu"],
  ["Friday", "fri"],
];

const PRIORITIES = ["PRIMARY", "High", "Important", "Medium", "Low", "Prep", "Recovery"] as const;

const RawEntry = z.object({
  block: z.string(),
  exercise: z.string(),
  prescription: z.string(),
  rest: z.string(),
  priority: z.enum(PRIORITIES),
  note: z.string().nullish(),
  time: z.string(),
});

const RawPlan = z.object({
  title: z.string(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weeks: z.array(
    z.object({
      week: z.number().int().positive(),
      phase: z.string(),
      days: z.object({
        Monday: z.array(RawEntry).default([]),
        Tuesday: z.array(RawEntry).default([]),
        Wednesday: z.array(RawEntry).default([]),
        Thursday: z.array(RawEntry).default([]),
        Friday: z.array(RawEntry).default([]),
      }),
    }),
  ),
});

export interface BuildOptions {
  equipment: Equipment[];
  hspuLadder: HspuStep[];
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function parseTime(time: string): { min: number | null; max: number | null } {
  const m = /^(\d+)(?:\s*[–-]\s*(\d+))?\s*min$/i.exec(time.trim());
  if (!m?.[1]) return { min: null, max: null };
  const min = Number(m[1]);
  return { min, max: m[2] ? Number(m[2]) : min };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function applyParse(parsed: ParsedPrescription) {
  return {
    sets_min: parsed.sets_min,
    sets_max: parsed.sets_max,
    reps_min: parsed.reps_min,
    reps_max: parsed.reps_max,
    per_side: parsed.per_side,
    duration_s_min: parsed.duration_s_min,
    duration_s_max: parsed.duration_s_max,
    hiit: parsed.hiit,
    tempo: parsed.tempo,
  };
}

export function buildPlan(rawBytes: string, opts: BuildOptions): ParsedPlan {
  const raw = RawPlan.parse(JSON.parse(rawBytes));
  const source_hash = createHash("sha256").update(rawBytes).digest("hex");

  const weeks: ParsedWeek[] = raw.weeks.map((w) => ({
    week: w.week,
    phase: w.phase,
    is_deload: w.phase === "Deload",
    is_test: w.phase === "Test",
    start_date: addDays(raw.start_date, 7 * (w.week - 1)),
  }));

  const items: ParsedItem[] = [];
  const used = new Set<string>();

  for (const w of raw.weeks) {
    const weekInfo = weeks.find((x) => x.week === w.week);
    const weekIsDeload = weekInfo?.is_deload ?? false;
    for (const [dayName, weekday] of WEEKDAYS) {
      const entries = w.days[dayName as keyof typeof w.days];
      entries.forEach((e, order) => {
        const map = PLAN_NAME_MAP[e.exercise];
        const flags: ParseFlag[] = [];
        let options: string[] = map ? [...map.options] : [];
        if (!map) {
          flags.push({ code: "unknown_exercise", detail: `No catalog entry for "${e.exercise}".` });
        }
        let optionExercises = options
          .map((s) => CATALOG_BY_SLUG.get(s))
          .filter((c): c is CatalogExercise => c !== undefined);
        const parsed = parsePrescription(e.prescription, {
          types: optionExercises.map((c) => c.type),
        });

        if (parsed.options_from_text.length > 0 && map && OR_PLAN_NAMES.has(e.exercise)) {
          options = parsed.options_from_text;
          optionExercises = options
            .map((s) => CATALOG_BY_SLUG.get(s))
            .filter((c): c is CatalogExercise => c !== undefined);
        } else if (parsed.options_from_text.length > 0 || TEXT_OPTION_PLAN_NAMES.has(e.exercise)) {
          flags.push({
            code: "or_option_unclear",
            detail:
              "Options in the text are missing or not allowed here; using the catalog defaults.",
          });
        }
        for (const s of options) used.add(s);

        const modifiers: Modifier[] = [...parsed.modifiers];
        if (map?.variant_label === "test" && !modifiers.includes("test")) modifiers.push("test");
        if (
          (map?.variant_label === "deload" || map?.variant_label === "weighted_deload") &&
          !modifiers.includes("deload")
        ) {
          modifiers.push("deload");
        }

        const tags: Tag[] = map ? [...map.tags] : [];
        const time = parseTime(e.time);
        const rir = computeRir({ options: optionExercises, modifiers, weekIsDeload });
        const base = `w${pad2(w.week)}-${weekday}-${pad2(order)}`;

        items.push({
          key: `${base}-0`,
          week: w.week,
          weekday,
          order,
          sub_item: 0,
          block: e.block,
          plan_name: e.exercise,
          exercise_options: options,
          variant_label: map?.variant_label ?? null,
          prescription_raw: e.prescription,
          extras_raw: parsed.extras_raw,
          ...applyParse(parsed),
          modifiers,
          hspu_step: parsed.hspu_step,
          ...rir,
          tags,
          rest_raw: e.rest,
          priority: e.priority as Priority,
          note: e.note?.trim() ? e.note.trim() : null,
          time_raw: e.time,
          time_min_min: time.min,
          time_min_max: time.max,
          fallback_prescription: fallbackFor(options),
          flags: [...flags, ...parsed.flags],
        });

        parsed.extras.forEach((x, i) => {
          const extraRir = computeRir({
            options: optionExercises,
            modifiers: x.modifiers,
            weekIsDeload,
          });
          items.push({
            key: `${base}-${i + 1}`,
            week: w.week,
            weekday,
            order,
            sub_item: i + 1,
            block: e.block,
            plan_name: e.exercise,
            exercise_options: options,
            variant_label: map?.variant_label ?? null,
            prescription_raw: e.prescription,
            extras_raw: parsed.extras_raw,
            sets_min: x.sets,
            sets_max: x.sets,
            reps_min: null,
            reps_max: null,
            per_side: false,
            duration_s_min: null,
            duration_s_max: null,
            hiit: null,
            tempo: null,
            modifiers: x.modifiers,
            hspu_step: null,
            ...extraRir,
            tags,
            rest_raw: e.rest,
            priority: e.priority as Priority,
            note: null,
            time_raw: e.time,
            time_min_min: null,
            time_min_max: null,
            fallback_prescription: fallbackFor(options),
            flags: x.flags,
          });
        });
      });
    }
  }

  return {
    source_hash,
    name: raw.title,
    start_date: raw.start_date,
    weeks_count: raw.weeks.length,
    weeks,
    exercises: CATALOG.filter((c) => used.has(c.slug)),
    equipment: opts.equipment,
    hspu_ladder: opts.hspuLadder,
    items,
  };
}
