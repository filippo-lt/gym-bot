/**
 * SYNTHETIC training history for the progression hand-simulation (SPEC 9, M5 plan).
 * Every number here is made up. It is one imaginary lifter, W1-W8 (28 Sep - 22 Nov 2026).
 *
 * ID MAPPING (the engine only sees numbers, the worksheet and expected.json use readable keys):
 *  - exerciseId     = 1-based index of the exercise in seed/plan.parsed.json `exercises` (see exerciseId()).
 *  - plannedItemId  = week * 10000 + (weekdayIndex + 1) * 1000 + order * 10 + sub_item
 *                     (mon=0 ... fri=4). Example: "w05-mon-02-0" -> 51020. itemKeyFor() reverses it.
 *                     The readable key is the real plan key from seed/plan.parsed.json.
 *
 * STORY: W1-W4 are the imported history (old tool): only the LAST set of an exercise has a RIR,
 * readiness GREEN. W5-W8 are bot-logged: RIR on every set. Conventions used:
 *  - Bodyweight stored on a session = the newest bodyweight entry on or before that day.
 *  - Recovery score is dated to that week's Friday. Only a score <= 2 becomes a `recovery_low` signal.
 *  - W6 Tue is YELLOW (frozen level), W7 Fri is RED (tired button + low recovery). Others GREEN.
 *  - Thursday class is "reported" every week. Class days count as training for the break rule.
 *  - No `session_implied` gate events: this lifter's pull-up estimate always implies far more than
 *    5 bodyweight reps, so the gate never closes.
 *  - Stored suggestions are null (no suggestion was shown in this made-up history); no drift signals.
 *  - Warm-ups, ring rows, leg raises, HIIT and mobility are not logged; they count as "logged" in
 *    `occurrences` (assumed done). Wednesday sessions are not part of this fixture.
 *  - Skips: lateral raise W3 Tue and Bulgarian split squat W3 Fri (heavy-legs Thursday), W7 Fri
 *    Bulgarian: single skips, never 2 in a row.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ParsedItem, ParsedPlan, Weekday } from "../../../src/plan-import/types.js";
import type {
  BodyweightRec,
  EquipmentRec,
  ExerciseInfo,
  GateEvent,
  HeavyGroup,
  HspuLadderStep,
  ItemOccurrence,
  ItemTarget,
  ReadinessLevel,
  ReadinessSignal,
  SessionInput,
  SessionRec,
  SetRec,
} from "../../../src/progression/types.js";

const root = resolve(import.meta.dirname, "../../..");
export const plan: ParsedPlan = JSON.parse(
  readFileSync(resolve(root, "seed/plan.parsed.json"), "utf8"),
);
interface RawEquipment {
  slug: string;
  base_kg: number | null;
  step_kg: number | null;
  discrete_values: number[] | null;
  bands: Record<string, number> | null;
}
export const equipmentSeed: RawEquipment[] = JSON.parse(
  readFileSync(resolve(root, "seed/equipment.json"), "utf8"),
);

export const PLAN_START = "2026-09-28";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

// ---------------------------------------------------------------------------
// ids and dates
// ---------------------------------------------------------------------------

export function exerciseId(slug: string): number {
  const i = plan.exercises.findIndex((e) => e.slug === slug);
  if (i < 0) throw new Error(`unknown exercise slug ${slug}`);
  return i + 1;
}

export function exerciseSlug(id: number): string {
  const e = plan.exercises[id - 1];
  if (!e) throw new Error(`unknown exercise id ${id}`);
  return e.slug;
}

export function plannedItemId(item: Pick<ParsedItem, "week" | "weekday" | "order" | "sub_item">) {
  return (
    item.week * 10000 +
    (WEEKDAYS.indexOf(item.weekday) + 1) * 1000 +
    item.order * 10 +
    item.sub_item
  );
}

export function itemKeyFor(id: number): string {
  const it = plan.items.find((i) => plannedItemId(i) === id);
  if (!it) throw new Error(`unknown planned item id ${id}`);
  return it.key;
}

export function dateOf(week: number, weekday: Weekday): string {
  const d = new Date(`${PLAN_START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + WEEKDAYS.indexOf(weekday));
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const idx = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const w = WEEKDAYS[idx];
  if (!w) throw new Error(`${date} is a weekend`);
  return w;
}

export function weekOf(date: string): number {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${PLAN_START}T00:00:00Z`)) / 86_400_000,
  );
  return Math.floor(days / 7) + 1;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// raw synthetic data
// ---------------------------------------------------------------------------

/** [reps, rir] ; rir "4+" means button "4+" (stored as rir 4, rirPlus true). */
type RS = [number, number | "4+"];

export const bodyweights: BodyweightRec[] = [
  { date: "2026-09-28", kg: 78.0 }, // setup
  { date: "2026-10-02", kg: 78.0 },
  { date: "2026-10-09", kg: 78.2 },
  { date: "2026-10-16", kg: 77.8 },
  { date: "2026-11-06", kg: 78.6 },
  { date: "2026-11-13", kg: 79.0 },
];

/** Thursday class per week. */
export const thursdayClasses: { date: string; week: number; heavyGroups: HeavyGroup[] }[] = [
  { week: 1, heavyGroups: ["pull"] },
  { week: 2, heavyGroups: ["push"] },
  { week: 3, heavyGroups: ["legs"] },
  { week: 4, heavyGroups: [] },
  { week: 5, heavyGroups: ["legs"] }, // Thu 29 Oct = legs
  { week: 6, heavyGroups: ["pull", "push"] },
  { week: 7, heavyGroups: [] },
  { week: 8, heavyGroups: ["legs"] },
].map((c) => ({ ...c, date: dateOf(c.week, "thu"), heavyGroups: c.heavyGroups as HeavyGroup[] }));

/** Weekly recovery score 1-5, dated to the Friday of that week. */
export const recoveryScores: { date: string; week: number; score: number }[] = [
  [1, 4],
  [2, 4],
  [3, 3],
  [4, 3],
  [6, 4],
  [7, 2],
  [8, 4],
].map(([week, score]) => ({
  week: week as number,
  score: score as number,
  date: dateOf(week as number, "fri"),
}));

/** Frozen readiness per session (default GREEN). */
const levelOverride: Record<string, ReadinessLevel> = {
  "6-tue": "YELLOW",
  "7-fri": "RED",
};

/** Signals: the W7 Fri RED day (tired button + low recovery). Expired by 23 Nov (engine applies expiry). */
export const readinessSignals: ReadinessSignal[] = [
  { at: "2026-11-13T06:10:00+01:00", kind: "button_tired" },
  { at: "2026-11-13T20:00:00+01:00", kind: "recovery_low" },
];

/** Weighted set groups: [week, weekday, slug, loadKg, sets]. */
const weighted: [number, Weekday, string, number, RS[]][] = [
  // ---- Monday: Romanian deadlift ----
  [
    1,
    "mon",
    "romanian_deadlift",
    70,
    [
      [8, 3],
      [8, 2],
      [8, 2],
    ],
  ],
  [
    2,
    "mon",
    "romanian_deadlift",
    75,
    [
      [8, 2],
      [8, 2],
      [8, 1],
    ],
  ],
  [
    3,
    "mon",
    "romanian_deadlift",
    77.5,
    [
      [8, 2],
      [8, 1],
      [7, 1],
    ],
  ],
  [
    4,
    "mon",
    "romanian_deadlift",
    55,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  [
    5,
    "mon",
    "romanian_deadlift",
    82.5,
    [
      [6, 2],
      [6, 2],
      [6, 1],
    ],
  ],
  [
    6,
    "mon",
    "romanian_deadlift",
    85,
    [
      [6, 1],
      [5, 1],
      [4, 0],
    ],
  ], // miss on the last set
  [
    7,
    "mon",
    "romanian_deadlift",
    85,
    [
      [6, 2],
      [6, 2],
      [6, 1],
    ],
  ],
  [
    8,
    "mon",
    "romanian_deadlift",
    60,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  // ---- Monday: lat pulldown (accessory, stack) ----
  [
    1,
    "mon",
    "lat_pulldown",
    50,
    [
      [12, 3],
      [11, 2],
    ],
  ],
  [
    2,
    "mon",
    "lat_pulldown",
    50,
    [
      [12, 3],
      [12, 2],
    ],
  ],
  [
    3,
    "mon",
    "lat_pulldown",
    52.5,
    [
      [11, 2],
      [10, 1],
    ],
  ],
  [4, "mon", "lat_pulldown", 40, [[10, 4]]],
  [
    5,
    "mon",
    "lat_pulldown",
    52.5,
    [
      [12, 3],
      [12, 2],
    ],
  ],
  [
    6,
    "mon",
    "lat_pulldown",
    55,
    [
      [12, 2],
      [10, 1],
    ],
  ],
  [
    7,
    "mon",
    "lat_pulldown",
    55,
    [
      [12, 3],
      [12, "4+"],
    ],
  ], // the one "4+"
  [8, "mon", "lat_pulldown", 40, [[10, 4]]],
  // ---- Tuesday: overhead press ----
  [
    1,
    "tue",
    "overhead_press",
    40,
    [
      [8, 2],
      [8, 2],
      [7, 1],
    ],
  ],
  [
    2,
    "tue",
    "overhead_press",
    42.5,
    [
      [8, 2],
      [7, 1],
      [7, 1],
    ],
  ],
  [
    3,
    "tue",
    "overhead_press",
    42.5,
    [
      [8, 2],
      [8, 1],
      [8, 1],
    ],
  ],
  [
    4,
    "tue",
    "overhead_press",
    30,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  [
    5,
    "tue",
    "overhead_press",
    45,
    [
      [6, 2],
      [6, 1],
      [5, 1],
    ],
  ],
  [
    6,
    "tue",
    "overhead_press",
    45,
    [
      [6, 2],
      [5, 1],
      [5, 1],
    ],
  ],
  [
    7,
    "tue",
    "overhead_press",
    47.5,
    [
      [5, 2],
      [5, 2],
      [5, 1],
    ],
  ],
  [
    8,
    "tue",
    "overhead_press",
    35,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  // ---- Tuesday: bench press ----
  [
    1,
    "tue",
    "bench_press",
    55,
    [
      [8, 2],
      [7, 1],
    ],
  ],
  [
    2,
    "tue",
    "bench_press",
    57.5,
    [
      [8, 2],
      [7, 1],
    ],
  ],
  [
    3,
    "tue",
    "bench_press",
    60,
    [
      [7, 2],
      [7, 1],
    ],
  ],
  [
    4,
    "tue",
    "bench_press",
    40,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  [
    5,
    "tue",
    "bench_press",
    62.5,
    [
      [6, 2],
      [6, 1],
    ],
  ],
  [
    6,
    "tue",
    "bench_press",
    62.5,
    [
      [6, 1],
      [6, 1],
      [5, 0],
    ],
  ],
  [
    7,
    "tue",
    "bench_press",
    65,
    [
      [6, 2],
      [5, 1],
    ],
  ],
  [
    8,
    "tue",
    "bench_press",
    45,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  // ---- Tuesday: squat ----
  [
    1,
    "tue",
    "squat",
    70,
    [
      [8, 3],
      [8, 2],
      [7, 1],
    ],
  ],
  [
    2,
    "tue",
    "squat",
    75,
    [
      [8, 2],
      [7, 2],
      [7, 1],
    ],
  ],
  [
    3,
    "tue",
    "squat",
    80,
    [
      [7, 2],
      [6, 2],
      [6, 1],
    ],
  ],
  [
    4,
    "tue",
    "squat",
    55,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  [
    5,
    "tue",
    "squat",
    85,
    [
      [6, 2],
      [5, 1],
      [5, 1],
    ],
  ],
  [
    6,
    "tue",
    "squat",
    87.5,
    [
      [5, 2],
      [5, 1],
      [5, 1],
    ],
  ],
  [
    7,
    "tue",
    "squat",
    87.5,
    [
      [5, 2],
      [5, 2],
      [5, 1],
    ],
  ],
  [
    8,
    "tue",
    "squat",
    60,
    [
      [6, 4],
      [6, 4],
    ],
  ],
  // ---- Tuesday: lateral raise (per hand). W3 skipped. ----
  [
    1,
    "tue",
    "lateral_raise",
    7.5,
    [
      [15, 2],
      [13, 1],
    ],
  ],
  [
    2,
    "tue",
    "lateral_raise",
    7.5,
    [
      [15, 2],
      [15, 2],
    ],
  ],
  [4, "tue", "lateral_raise", 5, [[12, 4]]],
  [
    5,
    "tue",
    "lateral_raise",
    10,
    [
      [13, 2],
      [12, 1],
    ],
  ],
  [
    6,
    "tue",
    "lateral_raise",
    10,
    [
      [15, 2],
      [14, 1],
    ],
  ],
  [
    7,
    "tue",
    "lateral_raise",
    10,
    [
      [15, 2],
      [15, 2],
    ],
  ],
  [8, "tue", "lateral_raise", 7.5, [[12, 4]]],
  // ---- Friday: squat (W2 hack squat instead; W6 hack squat instead) ----
  [
    1,
    "fri",
    "squat",
    72.5,
    [
      [6, 3],
      [6, 2],
      [6, 2],
    ],
  ],
  [
    2,
    "fri",
    "hack_squat",
    100,
    [
      [6, 2],
      [6, 1],
      [6, 1],
    ],
  ],
  [
    3,
    "fri",
    "squat",
    72.5,
    [
      [6, 3],
      [6, 3],
    ],
  ], // heavy-legs Thursday: 2 x reps_min, RIR 3-4 style
  [
    4,
    "fri",
    "squat",
    60,
    [
      [5, 4],
      [5, 4],
    ],
  ],
  [
    6,
    "fri",
    "hack_squat",
    110,
    [
      [6, 2],
      [6, 1],
      [5, 1],
    ],
  ],
  [
    7,
    "fri",
    "squat",
    75,
    [
      [4, 3],
      [4, 3],
      [4, 3],
    ],
  ], // RED session
  [8, "fri", "squat", 60, [[5, 4]]], // heavy legs + deload Friday: 1 easy set
  // ---- Friday: incline DB bench (per hand) ----
  [
    1,
    "fri",
    "incline_db_bench",
    20,
    [
      [10, 2],
      [9, 2],
      [8, 1],
    ],
  ],
  [
    2,
    "fri",
    "incline_db_bench",
    20,
    [
      [10, 3],
      [10, 2],
      [10, 2],
    ],
  ],
  [
    3,
    "fri",
    "incline_db_bench",
    22.5,
    [
      [10, 2],
      [9, 1],
      [8, 1],
    ],
  ],
  [
    4,
    "fri",
    "incline_db_bench",
    15,
    [
      [8, 4],
      [8, 4],
    ],
  ],
  [
    6,
    "fri",
    "incline_db_bench",
    22.5,
    [
      [8, 2],
      [6, 1],
      [5, 0],
    ],
  ],
  [
    7,
    "fri",
    "incline_db_bench",
    20,
    [
      [8, 3],
      [8, 3],
      [8, 3],
    ],
  ], // RED session
  [
    8,
    "fri",
    "incline_db_bench",
    15,
    [
      [8, 4],
      [8, 4],
    ],
  ],
  // ---- Friday: row (cable and machine are separate options) ----
  [
    1,
    "fri",
    "cable_row",
    45,
    [
      [10, 3],
      [10, 2],
      [9, 2],
    ],
  ],
  [
    2,
    "fri",
    "cable_row",
    47.5,
    [
      [10, 2],
      [10, 2],
      [10, 2],
    ],
  ],
  [
    3,
    "fri",
    "machine_row",
    50,
    [
      [10, 2],
      [9, 1],
      [8, 1],
    ],
  ],
  [
    4,
    "fri",
    "cable_row",
    35,
    [
      [8, 4],
      [8, 4],
    ],
  ],
  [
    6,
    "fri",
    "cable_row",
    50,
    [
      [8, 2],
      [8, 1],
      [7, 1],
    ],
  ],
  [
    7,
    "fri",
    "cable_row",
    45,
    [
      [8, 3],
      [8, 3],
      [8, 3],
    ],
  ], // RED session
  [
    8,
    "fri",
    "cable_row",
    35,
    [
      [8, 4],
      [8, 4],
    ],
  ],
  // ---- Friday: Bulgarian split squat (per hand). W3 skipped (heavy legs), W7 skipped (RED). ----
  [
    1,
    "fri",
    "bulgarian_split_squat",
    12.5,
    [
      [8, 3],
      [8, 2],
    ],
  ],
  [
    2,
    "fri",
    "bulgarian_split_squat",
    12.5,
    [
      [8, 3],
      [8, 2],
    ],
  ],
  [4, "fri", "bulgarian_split_squat", 10, [[8, 4]]],
  [
    6,
    "fri",
    "bulgarian_split_squat",
    15,
    [
      [8, 2],
      [8, 1],
    ],
  ],
  // ---- Friday: face pull ----
  [
    1,
    "fri",
    "face_pull",
    25,
    [
      [15, 3],
      [14, 2],
    ],
  ],
  [
    2,
    "fri",
    "face_pull",
    25,
    [
      [15, 3],
      [15, 2],
    ],
  ],
  [
    3,
    "fri",
    "face_pull",
    27.5,
    [
      [15, 2],
      [13, 1],
    ],
  ],
  [
    4,
    "fri",
    "face_pull",
    20,
    [
      [12, 4],
      [12, 4],
    ],
  ],
  [
    6,
    "fri",
    "face_pull",
    27.5,
    [
      [15, 2],
      [15, 1],
    ],
  ],
  [
    7,
    "fri",
    "face_pull",
    30,
    [
      [15, 3],
      [15, 3],
    ],
  ],
  [
    8,
    "fri",
    "face_pull",
    22.5,
    [
      [12, 4],
      [12, 4],
    ],
  ],
  // ---- Friday: triceps extension ----
  [
    1,
    "fri",
    "triceps_extension",
    20,
    [
      [12, 3],
      [11, 2],
    ],
  ],
  [
    2,
    "fri",
    "triceps_extension",
    20,
    [
      [12, 2],
      [12, 2],
    ],
  ],
  [
    3,
    "fri",
    "triceps_extension",
    22.5,
    [
      [10, 2],
      [9, 1],
    ],
  ],
  [
    6,
    "fri",
    "triceps_extension",
    22.5,
    [
      [12, 2],
      [12, 2],
    ],
  ],
  [
    7,
    "fri",
    "triceps_extension",
    25,
    [
      [12, 3],
      [12, 3],
    ],
  ],
];

/** Pull-up groups: sets are [reps, rir, addedKg, clean]. assist is always 0 (no bands used). */
type PS = [number, number, number, boolean];
const pullups: [number, PS[]][] = [
  [
    1,
    [
      [4, 3, 0, true],
      [4, 3, 0, true],
      [4, 2, 0, true],
      [4, 2, 0, true],
    ],
  ],
  [
    2,
    [
      [5, 3, 0, true],
      [5, 2, 0, true],
      [5, 2, 0, true],
      [5, 1, 0, true],
    ],
  ],
  [
    3,
    [
      [6, 3, 0, true],
      [6, 2, 0, true],
      [6, 2, 0, true],
      [6, 2, 0, true],
      [6, 1, 0, true],
    ],
  ], // 6 clean: opens the gate
  [
    4,
    [
      [3, 4, 0, true],
      [3, 4, 0, true],
    ],
  ], // deload
  [
    5,
    [
      [3, 2, 2.5, true],
      [3, 2, 2.5, true],
      [3, 1, 2.5, true],
      [3, 1, 2.5, true],
    ],
  ],
  [
    6,
    [
      [4, 2, 5, true],
      [3, 1, 5, true],
      [3, 1, 5, false],
      [3, 1, 5, true],
    ],
  ], // 3rd set unclean
  [
    7,
    [
      [3, 2, 7.5, true],
      [3, 1, 7.5, true],
      [3, 1, 7.5, true],
      [3, 0, 7.5, true],
      [2, 0, 7.5, true],
    ],
  ], // misses
  [
    8,
    [
      [3, 4, 2.5, true],
      [3, 4, 2.5, true],
    ],
  ], // deload
];

/** Check-in bodyweight max tests (bodyweight clean reps). */
const testMaxes: { date: string; reps: number }[] = [
  { date: "2026-10-09", reps: 5 },
  { date: "2026-10-16", reps: 7 },
];

/** HSPU groups: [week, stepOrder, padHeightCm|null, reps[]]. All clean, rir 2. */
const hspuLogs: [number, number, number | null, number[]][] = [
  [1, 2, null, [6, 6, 6, 6]], // feet-elevated pike push-up
  [2, 2, null, [8, 8, 8, 8]],
  [3, 3, null, [3, 3, 3]], // HSPU negative
  [4, 3, null, [3, 3]], // deload
  [5, 3, null, [3, 3, 3]], // behind the plan's partial-ROM step: uses the negative defaults
  [6, 4, 12, [4, 4, 3, 3]], // partial-ROM wall HSPU, pad 12 cm
  [7, 4, 10, [3, 3, 3, 3]],
  [8, 4, 10, [3, 3]], // deload
];

// ---------------------------------------------------------------------------
// building SessionRec[]
// ---------------------------------------------------------------------------

function bwAt(date: string): number {
  let kg = bodyweights[0]?.kg ?? 78;
  for (const b of bodyweights) if (b.date <= date) kg = b.kg;
  return kg;
}

function planItemFor(week: number, weekday: Weekday, slug: string): ParsedItem {
  const it = plan.items.find(
    (i) =>
      i.week === week &&
      i.weekday === weekday &&
      i.sub_item === 0 &&
      i.exercise_options.includes(slug),
  );
  if (!it) throw new Error(`no plan item for ${slug} in w${week} ${weekday}`);
  return it;
}

function baseRec(week: number, weekday: Weekday, slug: string, sets: SetRec[]): SessionRec {
  const date = dateOf(week, weekday);
  const item = planItemFor(week, weekday, slug);
  const w = plan.weeks.find((x) => x.week === week);
  const key = `${week}-${weekday}`;
  const imported = week <= 4;
  return {
    date,
    exerciseId: exerciseId(slug),
    plannedItemIds: [plannedItemId(item)],
    source: imported ? "import" : "bot",
    bwKg: bwAt(date),
    week,
    isDeload: w?.is_deload ?? false,
    isTest: w?.is_test ?? false,
    readiness: imported ? "GREEN" : (levelOverride[key] ?? "GREEN"),
    perSetUnknown: false,
    hspuStepOrder: null,
    padHeight: null,
    suggestion: null,
    sets: imported
      ? // Imported: the single RIR belongs to the last set.
        sets.map((s, i) => (i === sets.length - 1 ? s : { ...s, rir: null, rirPlus: false }))
      : sets,
  };
}

function setRec(over: Partial<SetRec>): SetRec {
  return {
    reps: null,
    loadKg: null,
    addedKg: null,
    assistKg: null,
    band: null,
    rir: null,
    rirPlus: false,
    clean: null,
    durationS: null,
    ...over,
  };
}

function buildAll(): SessionRec[] {
  const out: SessionRec[] = [];
  for (const [week, weekday, slug, load, sets] of weighted) {
    out.push(
      baseRec(
        week,
        weekday,
        slug,
        sets.map(([reps, rir]) =>
          setRec({ reps, loadKg: load, rir: rir === "4+" ? 4 : rir, rirPlus: rir === "4+" }),
        ),
      ),
    );
  }
  for (const [week, sets] of pullups) {
    out.push(
      baseRec(
        week,
        "mon",
        "pull_up",
        sets.map(([reps, rir, added, clean]) =>
          setRec({ reps, rir, addedKg: added, assistKg: 0, clean }),
        ),
      ),
    );
  }
  for (const [week, step, pad, reps] of hspuLogs) {
    const rec = baseRec(
      week,
      "tue",
      "hspu",
      reps.map((r) => setRec({ reps: r, rir: 2, clean: true })),
    );
    rec.hspuStepOrder = step;
    rec.padHeight = pad;
    out.push(rec);
  }
  return out.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.exerciseId - b.exerciseId,
  );
}

/** All synthetic sessions, oldest first. */
export const allSessions: SessionRec[] = buildAll();

/** Gate events from the synthetic log: every clean bodyweight pull-up set, plus check-in maxes. */
export function gateEventsBefore(date: string): GateEvent[] {
  const events: GateEvent[] = [];
  const pu = exerciseId("pull_up");
  for (const s of allSessions) {
    if (s.exerciseId !== pu || s.date >= date) continue;
    for (const set of s.sets) {
      if (set.clean === true && (set.addedKg ?? 0) === 0 && (set.assistKg ?? 0) === 0 && set.reps) {
        events.push({ kind: "clean_bw_set", date: s.date, reps: set.reps });
      }
    }
  }
  for (const t of testMaxes) if (t.date < date) events.push({ kind: "test_max", ...t });
  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// SessionInput builders
// ---------------------------------------------------------------------------

export const HAND_SIM_DATES = ["2026-10-26", "2026-10-30", "2026-11-23"] as const;
export type HandSimDate = (typeof HAND_SIM_DATES)[number];

function equipmentRec(slug: string): EquipmentRec {
  const e = equipmentSeed.find((x) => x.slug === slug);
  if (!e) throw new Error(`unknown equipment ${slug}`);
  return {
    slug: e.slug,
    baseKg: e.base_kg,
    stepKg: e.step_kg,
    discreteValues: e.discrete_values,
    bands: e.bands ?? {},
  };
}

function exercisesMap(): Record<number, ExerciseInfo> {
  const out: Record<number, ExerciseInfo> = {};
  plan.exercises.forEach((e, i) => {
    out[i + 1] = {
      id: i + 1,
      slug: e.slug,
      type: e.type,
      loadBasis: e.load_basis,
      isMainLift: e.is_main_lift,
      equipment: e.equipment_slug ? equipmentRec(e.equipment_slug) : null,
    };
  });
  return out;
}

export const hspuLadder: HspuLadderStep[] = plan.hspu_ladder.map((h) => ({
  id: h.order,
  stepOrder: h.order,
  slug: h.slug,
  name: h.name,
  defaultSets: h.default_sets,
  defaultRepsMin: h.default_reps_min,
  defaultRepsMax: h.default_reps_max,
  tempo: h.tempo,
}));

export function itemsFor(date: string): ParsedItem[] {
  const week = weekOf(date);
  const weekday = weekdayOf(date);
  return plan.items
    .filter((i) => i.week === week && i.weekday === weekday)
    .sort((a, b) => a.order - b.order || a.sub_item - b.sub_item);
}

function toTarget(i: ParsedItem): ItemTarget {
  const w = plan.weeks.find((x) => x.week === i.week);
  const ladderStep = i.hspu_step ? plan.hspu_ladder.find((h) => h.slug === i.hspu_step) : undefined;
  return {
    plannedItemId: plannedItemId(i),
    subItem: i.sub_item,
    exerciseIds: i.exercise_options.map(exerciseId),
    setsMin: i.sets_min,
    setsMax: i.sets_max,
    repsMin: i.reps_min,
    repsMax: i.reps_max,
    rirMin: i.rir_min,
    rirMax: i.rir_max,
    modifiers: i.modifiers,
    tags: i.tags,
    priority: i.priority,
    isDeload: w?.is_deload ?? false,
    isTest: i.modifiers.includes("test"),
    hiit: i.hiit,
    fallback: i.fallback_prescription,
    hspuStepOrder: ladderStep?.order ?? null,
    order: i.order,
    planName: i.plan_name,
  };
}

function occurrencesFor(date: string, items: ParsedItem[]): ItemOccurrence[] {
  const week = weekOf(date);
  return items.map((it) => {
    const occ: ItemOccurrence["occurrences"] = [];
    for (let w = 1; w < week; w++) {
      const wk = plan.weeks.find((x) => x.week === w);
      if (!wk || wk.is_deload) continue; // deload weeks excluded
      const same = plan.items.find(
        (x) =>
          x.week === w &&
          x.weekday === it.weekday &&
          x.sub_item === it.sub_item &&
          x.exercise_options.join(",") === it.exercise_options.join(","),
      );
      if (!same) continue;
      const d = dateOf(w, it.weekday);
      const ids = same.exercise_options.map(exerciseId);
      const tracked = allSessions.some(
        (s) => ids.includes(s.exerciseId) && s.plannedItemIds.includes(plannedItemId(same)),
      );
      const trackedType = same.exercise_options.some((slug) => {
        const ex = plan.exercises.find((e) => e.slug === slug);
        return (
          ex?.type === "weighted" || ex?.type === "bodyweight_plus" || ex?.type === "skill_ladder"
        );
      });
      // Untracked item types (warm-ups, leg raises...) are assumed logged.
      occ.push({ date: d, logged: trackedType ? tracked : true });
    }
    return { plannedItemId: plannedItemId(it), occurrences: occ };
  });
}

function lastTrainingBefore(date: string): string | null {
  const days = [...allSessions.map((s) => s.date), ...thursdayClasses.map((c) => c.date)].filter(
    (d) => d < date,
  );
  return days.length ? (days.sort().at(-1) ?? null) : null;
}

/** Build the engine input for one session date, using only data strictly before that date. */
export function buildSessionInput(date: string): SessionInput {
  const week = weekOf(date);
  const weekday = weekdayOf(date);
  const w = plan.weeks.find((x) => x.week === week);
  if (!w) throw new Error(`date ${date} is outside the plan`);
  const parsedItems = itemsFor(date);

  const history: Record<number, SessionRec[]> = {};
  for (const s of allSessions) {
    if (s.date >= date) continue;
    const list = history[s.exerciseId] ?? [];
    list.push(s);
    history[s.exerciseId] = list;
  }
  for (const list of Object.values(history)) list.sort((a, b) => (a.date < b.date ? 1 : -1));

  const bw = [...bodyweights].filter((b) => b.date <= date).at(-1) ?? null;
  const thursday = weekday === "fri" ? addDays(date, -1) : null;
  const cls = thursday ? thursdayClasses.find((c) => c.date === thursday) : undefined;

  return {
    date,
    weekday,
    week,
    isDeload: w.is_deload,
    isTest: w.is_test,
    items: parsedItems.map(toTarget),
    history,
    exercises: exercisesMap(),
    bodyweight: bw ? { ...bw } : null,
    gateEvents: gateEventsBefore(date),
    hspuLadder,
    heavyGroups: cls?.heavyGroups ?? [],
    // Non-Fridays never ask for the class; Fridays only ask when no class record exists.
    classReported: weekday === "fri" ? cls !== undefined : true,
    readinessSignals: readinessSignals.filter((s) => s.at < `${date}T06:00:00+01:00`),
    frozenLevel: null,
    short: false,
    lastTrainingDate: lastTrainingBefore(date),
    occurrences: occurrencesFor(date, parsedItems),
  };
}

/** Days between two ISO dates (helper for the worksheet). */
export { daysBetween };

// ---------------------------------------------------------------------------
// Which items the user fills in expected.json
// ---------------------------------------------------------------------------

export interface ExpectedSlot {
  /** Key in expected.json: the plan item key, plus ":<slug>" when the item has 2+ options (OR items). */
  key: string;
  itemKey: string;
  plannedItemId: number;
  slug: string;
  exerciseId: number;
}

/** Items with load math (types weighted / bodyweight_plus), one slot per option. */
export function expectedSlots(date: string): ExpectedSlot[] {
  const out: ExpectedSlot[] = [];
  for (const it of itemsFor(date)) {
    const multi = it.exercise_options.length > 1;
    for (const slug of it.exercise_options) {
      const ex = plan.exercises.find((e) => e.slug === slug);
      if (ex?.type !== "weighted" && ex?.type !== "bodyweight_plus") continue;
      out.push({
        key: multi ? `${it.key}:${slug}` : it.key,
        itemKey: it.key,
        plannedItemId: plannedItemId(it),
        slug,
        exerciseId: exerciseId(slug),
      });
    }
  }
  return out;
}
