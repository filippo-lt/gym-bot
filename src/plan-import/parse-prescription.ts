import { matchHspuPrefix } from "./hspu.js";
import type { ExerciseType, HiitSpec, Modifier, ParseFlag } from "./types.js";

export interface ParseContext {
  /** Types of the candidate exercises; decides which leftovers are flagged. */
  types: ExerciseType[];
}

export interface ParsedExtra {
  raw: string;
  sets: number;
  modifiers: Modifier[];
  flags: ParseFlag[];
}

export interface ParsedPrescription {
  sets_min: number | null;
  sets_max: number | null;
  reps_min: number | null;
  reps_max: number | null;
  per_side: boolean;
  duration_s_min: number | null;
  duration_s_max: number | null;
  hiit: HiitSpec | null;
  tempo: string | null;
  modifiers: Modifier[];
  hspu_step: string | null;
  /** Exercise slugs named in the text ("OHP or bench: …"). */
  options_from_text: string[];
  extras_raw: string | null;
  extras: ParsedExtra[];
  /** Text no rule consumed. Fine for descriptive types, flagged for load-math types. */
  leftover: string;
  flags: ParseFlag[];
}

const DASH = "–";
const RANGE = "(\\d+)(?:–(\\d+))?";
const FLAGGED_LEFTOVER_TYPES: ExerciseType[] = [
  "weighted",
  "bodyweight_plus",
  "skill_ladder",
  "bodyweight_reps",
  "timed",
];
const VOLUME_TYPES = FLAGGED_LEFTOVER_TYPES;

export function normalize(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\d)\s*-\s*(\d)/g, `$1${DASH}$2`)
    .replace(/(\d)\s*[x×]\s*(\d)/gi, "$1 × $2");
}

function num(s: string | undefined): number | null {
  return s === undefined ? null : Number(s);
}

function cleanLeftover(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s;,.:+]+|[\s;,.:+]+$/g, "")
    .trim();
}

const OPTION_SLUGS: Record<string, string> = { ohp: "overhead_press", bench: "bench_press" };

export function parsePrescription(raw: string, ctx: ParseContext): ParsedPrescription {
  const isTypeIn = (list: ExerciseType[]) => ctx.types.some((t) => list.includes(t));
  const out: ParsedPrescription = {
    sets_min: null,
    sets_max: null,
    reps_min: null,
    reps_max: null,
    per_side: false,
    duration_s_min: null,
    duration_s_max: null,
    hiit: null,
    tempo: null,
    modifiers: [],
    hspu_step: null,
    options_from_text: [],
    extras_raw: null,
    extras: [],
    leftover: "",
    flags: [],
  };
  const addModifier = (m: Modifier) => {
    if (!out.modifiers.includes(m)) out.modifiers.push(m);
  };

  let rest = normalize(raw);

  // Multi-move text: keep raw, nothing to parse.
  if (rest.includes("·")) {
    out.leftover = raw.replace(/\s+/g, " ").trim();
    if (isTypeIn(FLAGGED_LEFTOVER_TYPES)) {
      out.flags.push({ code: "unparsed_text", detail: out.leftover });
    }
    return out;
  }

  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return m;
  };

  // Leading markers.
  if (take(/^optional\b[\s:]*/i)) addModifier("optional");
  if (take(/^deload\s*:\s*/i)) addModifier("deload");
  if (take(/^test\s*:\s*/i)) addModifier("test");
  const optMatch = take(/^(ohp|bench)\s+or\s+(ohp|bench)\s*:\s*/i);
  if (optMatch?.[1] && optMatch[2]) {
    for (const key of [optMatch[1], optMatch[2]]) {
      const slug = OPTION_SLUGS[key.toLowerCase()];
      if (slug && !out.options_from_text.includes(slug)) out.options_from_text.push(slug);
    }
  }

  // HSPU ladder prefix.
  if (ctx.types.includes("skill_ladder")) {
    const hit = matchHspuPrefix(rest);
    if (hit) {
      rest = hit.rest;
      if (hit.kind === "step") out.hspu_step = hit.step;
    }
    if (out.hspu_step === null) {
      out.flags.push({
        code: "hspu_step_from_state",
        detail: "Step is not named in the plan; the current progression comes from your state.",
      });
    }
  }

  // "+ 1 easy BW set" → extra sub-item.
  const extra = take(/\+\s*(\d+)\s+(?:(easy)\s+)?(?:BW\s+)?sets?\b/i);
  if (extra?.[1]) {
    const raw = extra[0].replace(/\s+/g, " ").trim();
    out.extras_raw = raw;
    out.extras.push({
      raw,
      sets: Number(extra[1]),
      modifiers: extra[2] ? ["easy"] : [],
      flags: [{ code: "missing_reps", detail: `Extra "${raw}" has no rep target.` }],
    });
  }

  // "(or stop 1 rep before form breaks)"
  if (take(/\(\s*or stop \d+ reps? before form breaks\s*\)/i)) {
    addModifier("stop_before_form_breaks");
  }

  // HIIT: 8 × 30s hard / 90s easy
  const hiit = take(/(\d+)\s*×\s*(\d+)\s*s\s+hard\s*\/\s*(\d+)\s*s\s+easy/i);
  if (hiit?.[1] && hiit[2] && hiit[3]) {
    out.hiit = { rounds: Number(hiit[1]), work_s: Number(hiit[2]), rest_s: Number(hiit[3]) };
  }

  // Max-effort attempts: "3 max-clean attempts", "3–5 serious attempts".
  let maxAttempts = false;
  const attempts = take(new RegExp(`${RANGE}\\s*(?:max-clean|serious)\\s+attempts?`, "i"));
  if (attempts?.[1]) {
    maxAttempts = true;
    out.sets_min = Number(attempts[1]);
    out.sets_max = num(attempts[2]) ?? out.sets_min;
    addModifier("test");
    addModifier("max_attempts");
    out.flags.push({
      code: "max_reps",
      detail: "Reps are open-ended (max clean reps); no rep number to store.",
    });
  }
  const optionalExtra = take(/[;,]\s*optional\s+([^;]+)/i);
  if (optionalExtra?.[1]) {
    const text = optionalExtra[1].trim();
    out.extras_raw = text;
    out.flags.push({ code: "optional_extra", detail: `Optional extra: ${text}` });
  }
  if (maxAttempts) take(/[;,]?\s*record reps \+ ROM \/ pad height/i);

  // Tempo: "5s down"
  const tempo = take(/,?\s*(\d+)\s*s down\b/i);
  if (tempo?.[1]) out.tempo = `${tempo[1]}s down`;

  // Sets × seconds ("2 × 25s") before sets × reps.
  const setsSecs = take(new RegExp(`${RANGE}\\s*×\\s*${RANGE}\\s*s\\b`, "i"));
  if (setsSecs?.[1] && setsSecs[3]) {
    out.sets_min = Number(setsSecs[1]);
    out.sets_max = num(setsSecs[2]) ?? out.sets_min;
    out.duration_s_min = Number(setsSecs[3]);
    out.duration_s_max = num(setsSecs[4]) ?? out.duration_s_min;
  } else {
    const sr = take(
      new RegExp(`${RANGE}\\s*×\\s*${RANGE}(?:\\s*\\/\\s*(?:leg|side))?(?![\\d${DASH}])`),
    );
    if (sr?.[1] && sr[3]) {
      out.sets_min = Number(sr[1]);
      out.sets_max = num(sr[2]) ?? out.sets_min;
      out.reps_min = Number(sr[3]);
      out.reps_max = num(sr[4]) ?? out.reps_min;
      out.per_side = sr[0].includes("/");
    }
  }

  // Durations: "5–7 min".
  const dur = take(new RegExp(`${RANGE}\\s*min\\b`, "i"));
  if (dur?.[1]) {
    out.duration_s_min = Number(dur[1]) * 60;
    out.duration_s_max = (num(dur[2]) ?? Number(dur[1])) * 60;
  }

  // Bare sets: "2 easy sets, then stop".
  if (out.sets_min === null) {
    const bare = take(/(\d+)\s+(?:(easy)\s+)?sets?\b/i);
    if (bare?.[1]) {
      out.sets_min = Number(bare[1]);
      out.sets_max = out.sets_min;
      if (bare[2]) addModifier("easy");
      take(/,?\s*then stop\b/i);
    }
  }

  // Modifier words.
  if (take(/\bheavy-clean\b/i)) addModifier("heavy_clean");
  if (take(/\bslightly heavier\b/i)) addModifier("slightly_heavier");
  if (take(/\beasy\b/i)) addModifier("easy");
  if (take(/\blight\b/i)) addModifier("light");

  out.leftover = cleanLeftover(rest);

  if (out.leftover && /[A-Za-z0-9]/.test(out.leftover) && isTypeIn(FLAGGED_LEFTOVER_TYPES)) {
    out.flags.push({ code: "unparsed_text", detail: out.leftover });
  }

  if (isTypeIn(VOLUME_TYPES)) {
    const hasVolume = out.reps_min !== null || out.duration_s_min !== null;
    if (out.sets_min === null) {
      out.flags.push({ code: "missing_sets", detail: "No set count found." });
    } else if (!hasVolume && !maxAttempts) {
      out.flags.push({ code: "missing_reps", detail: "No rep or duration target found." });
    }
  }

  return out;
}
