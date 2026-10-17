import type { OpenIssue, ParsedItem, ResolvedPlan, Weekday } from "./types.js";

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
};
const DAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function range(min: number | null, max: number | null): string {
  if (min === null) return "";
  return max === null || max === min ? String(min) : `${min}–${max}`;
}

function secs(s: number | null, e: number | null): string {
  if (s === null) return "";
  if (s % 60 === 0 && (e === null || e % 60 === 0))
    return `${range(s / 60, e === null ? null : e / 60)} min`;
  return `${range(s, e)}s`;
}

/** Short human text for the parsed fields, e.g. `4×3–4 · RIR 1–2 · easy`. */
export function formatParsed(i: ParsedItem): string {
  const parts: string[] = [];
  if (i.sets_min !== null) {
    let v = `${range(i.sets_min, i.sets_max)}×${i.reps_min === null ? "?" : range(i.reps_min, i.reps_max)}`;
    if (i.reps_min === null && i.duration_s_min !== null) {
      v = `${range(i.sets_min, i.sets_max)}×${secs(i.duration_s_min, i.duration_s_max)}`;
    }
    if (i.per_side) v += "/side";
    parts.push(v);
  } else if (i.duration_s_min !== null) {
    parts.push(secs(i.duration_s_min, i.duration_s_max));
  }
  if (i.hiit) parts.push(`${i.hiit.rounds}×${i.hiit.work_s}s on/${i.hiit.rest_s}s off`);
  if (i.tempo) parts.push(`tempo ${i.tempo}`);
  if (i.rir_min !== null) parts.push(`RIR ${range(i.rir_min, i.rir_max)}`);
  if (i.modifiers.length) parts.push(i.modifiers.join(", "));
  if (i.hspu_step) parts.push(`step ${i.hspu_step}`);
  const text = parts.join(" · ") || "(raw text only)";
  return i.sub_item > 0 ? `extra: ${text}` : text;
}

function weeksLabel(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const out: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] ?? 0) === (sorted[j] ?? 0) + 1) j++;
    const a = sorted[i];
    const b = sorted[j];
    out.push(j - i >= 1 ? `${a}–${b}` : `${a}`);
    i = j + 1;
  }
  return out.join(", ");
}

export interface ReviewRow {
  weekday: Weekday;
  weeks: number[];
  first: ParsedItem;
}

/** Collapse identical (plan_name, prescription_raw, parse result) across weeks, per weekday. */
export function collapseItems(items: ParsedItem[]): ReviewRow[] {
  const rows = new Map<string, ReviewRow>();
  for (const it of items) {
    const sig = JSON.stringify([
      it.weekday,
      it.plan_name,
      it.prescription_raw,
      it.sub_item,
      it.exercise_options,
      it.variant_label,
      it.extras_raw,
      [it.sets_min, it.sets_max, it.reps_min, it.reps_max, it.per_side],
      [it.duration_s_min, it.duration_s_max, it.hiit, it.tempo],
      it.modifiers,
      it.hspu_step,
      [it.rir_min, it.rir_max],
      it.tags,
      it.priority,
      it.note,
      it.time_raw,
      it.fallback_prescription,
      it.flags,
    ]);
    const row = rows.get(sig);
    if (row) row.weeks.push(it.week);
    else rows.set(sig, { weekday: it.weekday, weeks: [it.week], first: it });
  }
  return [...rows.values()].sort(
    (a, b) =>
      DAY_ORDER.indexOf(a.weekday) - DAY_ORDER.indexOf(b.weekday) ||
      (a.weeks[0] ?? 0) - (b.weeks[0] ?? 0) ||
      a.first.order - b.first.order ||
      a.first.sub_item - b.first.sub_item,
  );
}

export function flagsText(i: ParsedItem): string {
  return i.flags.map((f) => `**${f.code}**`).join(", ");
}

/** One line per collapsed row; used for the file snapshot in tests. */
export function collapsedRowLines(items: ParsedItem[]): string[] {
  return collapseItems(items).map((r) =>
    [
      DAY_NAMES[r.weekday],
      weeksLabel(r.weeks),
      r.first.plan_name,
      r.first.prescription_raw,
      formatParsed(r.first),
      r.first.tags.join(","),
      r.first.priority,
      r.first.note ?? "",
      r.first.time_raw,
      r.first.flags.map((f) => f.code).join(","),
    ].join(" | "),
  );
}

function table(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ];
}

const HINTS: Record<OpenIssue["scope"], string> = {
  plan: "If the plan file changed, review the plan again first, then update `source_hash` in `seed/plan-overrides.json`.",
  item: "Edit `seed/plan-overrides.json`. Put the item key under `items`, set the fields you want, and list the flag codes you accept in `resolve`. See the ready-to-paste examples below.",
  equipment:
    "Edit `seed/equipment.json`. Fill `base_kg` (empty bar or unloaded sled), `step_kg` (smallest weight step) or `discrete_values` (list of available weights), and `bands` (colour to kg) for the pull-up bar.",
  hspu_ladder:
    "Edit `seed/hspu-ladder.json`. Fill `default_sets`, `default_reps_min` and `default_reps_max` for the step.",
  exercise:
    'Answer in `seed/plan-overrides.json` under `exercises`. Example: `"exercises": { "triceps_extension": { "acknowledge": true } }`. You can also change `type`, `load_basis`, `equipment_slug` or `muscle_group` there.',
};

const SCOPE_TITLES: Record<OpenIssue["scope"], string> = {
  plan: "Plan file",
  item: "Plan items",
  equipment: "Equipment",
  hspu_ladder: "HSPU ladder",
  exercise: "Exercises",
};

const FLAG_GUIDE: Record<string, { text: string; snippets: (key: string) => string[] }> = {
  hspu_step_from_state: {
    text: 'Accept: your current HSPU step decides. Add the key with `resolve: ["hspu_step_from_state"]`.',
    snippets: (k) => [`"${k}": { "resolve": ["hspu_step_from_state"] }`],
  },
  missing_reps: {
    text: "Enter reps, or accept open reps.",
    snippets: (k) => [
      `"${k}": { "reps_min": 8, "reps_max": 8, "resolve": ["missing_reps"] }`,
      `"${k}": { "resolve": ["missing_reps"] }`,
    ],
  },
  max_reps: {
    text: "Accept: test = as many clean reps as possible.",
    snippets: (k) => [`"${k}": { "resolve": ["max_reps"] }`],
  },
  optional_extra: {
    text: "Accept: the optional part stays as text.",
    snippets: (k) => [`"${k}": { "resolve": ["optional_extra"] }`],
  },
};

const LEGEND = [
  "- **RIR**: reps in reserve. RIR 2 means you stop with about 2 more reps possible.",
  "- **×?**: the number of reps is open (not written in the plan).",
  "- **step**: the HSPU ladder step named in the plan.",
  "- **(raw text only)**: a list of moves. It is kept as written, with no numbers read from it.",
  "- **on/off**: HIIT work seconds / rest seconds. `8×30s on/90s off` means 8 rounds of 30 s hard and 90 s easy.",
  "- **easy**: light effort, stay far from failure.",
  "- **light**: lighter weight than usual.",
  "- **optional**: you may skip it.",
  "- **heavy_clean**: heavy but every rep is clean.",
  "- **slightly_heavier**: a bit more weight than last time.",
  "- **test**: a max-effort test.",
  "- **deload**: an easy recovery week or item.",
  "- **max_attempts**: several all-out attempts, count the best.",
  "- **stop_before_form_breaks**: stop one rep before your technique gets worse.",
];

export function renderReview(resolved: ResolvedPlan): { markdown: string; csv: string } {
  const { plan, open_issues } = resolved;
  const L: string[] = [];
  const bySlug = new Map(plan.exercises.map((e) => [e.slug, e]));
  const rows = collapseItems(plan.items);

  L.push(`# Plan review: ${plan.name}`, "");
  L.push("## How to read this file", "", ...LEGEND, "");
  L.push("## 1. Summary", "");
  L.push(`- Source hash: \`${plan.source_hash}\``);
  L.push(`- Weeks: ${plan.weeks_count}, starting ${plan.start_date}`);
  const extras = plan.items.filter((i) => i.sub_item > 0);
  const extraText =
    extras.length > 0
      ? ` (${plan.items.length - extras.length} plan rows + ${extras.length} extra set${extras.length > 1 ? "s" : ""} split out: ${extras.map((i) => i.key).join(", ")})`
      : "";
  L.push(`- Items: ${plan.items.length}${extraText}`);
  L.push(`- Exercises: ${plan.exercises.length}`);
  L.push(`- Open issues: ${open_issues.length}`, "");
  L.push(
    ...table(
      ["Week", "Starts (Monday)", "Phase"],
      plan.weeks.map((w) => [String(w.week), w.start_date, w.phase]),
    ),
    "",
  );

  L.push("## 2. Open issues", "");
  if (open_issues.length === 0) L.push("None. The plan is ready to seed.", "");
  for (const scope of ["plan", "item", "equipment", "hspu_ladder", "exercise"] as const) {
    const list = open_issues.filter((o) => o.scope === scope);
    if (list.length === 0) continue;
    L.push(`### ${SCOPE_TITLES[scope]} (${list.length})`, "", `How to fix: ${HINTS[scope]}`, "");
    L.push(
      ...table(
        ["Ref", "What"],
        list.map((o) => [`\`${o.ref}\``, o.detail]),
      ),
      "",
    );
    if (scope === "item") {
      for (const [code, guide] of Object.entries(FLAG_GUIDE)) {
        const hit = list.find((o) => o.detail.startsWith(`${code}:`));
        if (!hit) continue;
        L.push(`**${code}**: ${guide.text}`, "", "```json", ...guide.snippets(hit.ref), "```", "");
      }
    }
    if (scope === "exercise") {
      L.push("```json", `"exercises": { "${list[0]?.ref}": { "acknowledge": true } }`, "```", "");
    }
  }

  L.push("## 3. Exercise mapping", "");
  const seen = new Map<string, { item: ParsedItem; options: string[] }>();
  for (const it of plan.items) {
    const hit = seen.get(it.plan_name);
    if (!hit) seen.set(it.plan_name, { item: it, options: [...it.exercise_options] });
    else for (const o of it.exercise_options) if (!hit.options.includes(o)) hit.options.push(o);
  }
  L.push(
    ...table(
      ["Plan name", "Options", "Type", "Load basis", "Equipment", "Main", "Tags", "Note"],
      [...seen.values()].map(({ item: it, options }) => {
        const opts = options.map((s) => bySlug.get(s));
        return [
          it.plan_name,
          options.join(" / ") || "(unknown)",
          opts.map((o) => o?.type ?? "?").join(" / "),
          opts.map((o) => o?.load_basis ?? "-").join(" / "),
          opts.map((o) => o?.equipment_slug ?? "-").join(" / "),
          opts.map((o) => (o?.is_main_lift ? "yes" : "no")).join(" / "),
          it.tags.join(", "),
          [...new Set(opts.map((o) => o?.review_note).filter(Boolean))].join(" ; "),
        ];
      }),
    ),
    "",
  );

  L.push("## 4. Parsed items", "");
  for (const day of DAY_ORDER) {
    const dayRows = rows.filter((r) => r.weekday === day);
    if (dayRows.length === 0) continue;
    L.push(`### ${DAY_NAMES[day]}`, "");
    L.push(
      ...table(
        ["Weeks", "Exercise", "Raw", "Parsed", "Tags", "Priority", "Note", "Time", "Flags"],
        dayRows.map((r) => [
          weeksLabel(r.weeks),
          r.first.plan_name,
          r.first.prescription_raw,
          formatParsed(r.first),
          r.first.tags.join(", "),
          r.first.priority,
          r.first.note ?? "",
          r.first.time_raw,
          flagsText(r.first),
        ]),
      ),
      "",
    );
  }

  L.push("## 5. Fallback, HSPU ladder and equipment", "");
  L.push("### Pull-up fallback (while the weighted gate is closed)", "");
  const fb = plan.items.find((i) => i.fallback_prescription)?.fallback_prescription;
  if (fb) {
    L.push(
      `- If last bodyweight max is at least ${fb.if_bw_max_gte} clean reps: ${fb.then.sets} × ${fb.then.reps_min}–${fb.then.reps_max} (${fb.then.mode}).`,
      `- Otherwise: ${fb.else.sets} × ${fb.else.reps_min} (${fb.else.mode}).`,
      "",
    );
  }
  const cell = (v: number | string | null) => (v === null ? "**empty**" : String(v));
  L.push("### HSPU ladder", "");
  L.push(
    ...table(
      ["Order", "Step", "Sets", "Reps min", "Reps max", "Tempo"],
      plan.hspu_ladder.map((s) => [
        String(s.order),
        s.name,
        cell(s.default_sets),
        cell(s.default_reps_min),
        cell(s.default_reps_max),
        s.tempo ?? "-",
      ]),
    ),
    "",
  );
  L.push("### Equipment", "");
  L.push(
    ...table(
      ["Slug", "Name", "Base kg", "Step kg", "Discrete values", "Bands"],
      plan.equipment.map((e) => [
        e.slug,
        e.name,
        cell(e.base_kg),
        cell(e.step_kg),
        e.discrete_values ? e.discrete_values.join(", ") : "**empty**",
        e.bands ? JSON.stringify(e.bands) : "**empty**",
      ]),
    ),
    "",
  );

  return { markdown: `${L.join("\n")}\n`, csv: renderCsv(plan.items) };
}

const CSV_COLUMNS: (keyof ParsedItem)[] = [
  "key",
  "week",
  "weekday",
  "order",
  "sub_item",
  "block",
  "plan_name",
  "exercise_options",
  "variant_label",
  "prescription_raw",
  "extras_raw",
  "sets_min",
  "sets_max",
  "reps_min",
  "reps_max",
  "per_side",
  "duration_s_min",
  "duration_s_max",
  "hiit",
  "tempo",
  "modifiers",
  "hspu_step",
  "rir_min",
  "rir_max",
  "tags",
  "rest_raw",
  "priority",
  "note",
  "time_raw",
  "time_min_min",
  "time_min_max",
  "fallback_prescription",
  "flags",
];

function csvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = "";
  else if (Array.isArray(v)) {
    s = v
      .map((x) =>
        typeof x === "object"
          ? `${(x as { code: string }).code}: ${(x as { detail: string }).detail}`
          : String(x),
      )
      .join(" | ");
  } else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCsv(items: ParsedItem[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const it of items) lines.push(CSV_COLUMNS.map((c) => csvCell(it[c])).join(","));
  return `${lines.join("\n")}\n`;
}
