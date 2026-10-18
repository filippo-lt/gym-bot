import type {
  CatalogExercise,
  Equipment,
  ParsedItem,
  ResolvedPlan,
  Weekday,
} from "../../src/plan-import/types.js";

export const PLAN_NAME = "Synthetic Plan";

export const EQUIPMENT: Equipment[] = [
  {
    slug: "barbell",
    name: "Barbell",
    base_kg: 15,
    step_kg: 2.5,
    discrete_values: null,
    bands: null,
  },
  {
    slug: "dumbbells",
    name: "Dumbbells",
    base_kg: null,
    step_kg: 2.5,
    discrete_values: null,
    bands: null,
  },
  {
    slug: "cable_stack",
    name: "Cable stack",
    base_kg: null,
    step_kg: 2.5,
    discrete_values: null,
    bands: null,
  },
  {
    slug: "hack_squat",
    name: "Hack squat",
    base_kg: null,
    step_kg: 2.5,
    discrete_values: null,
    bands: null,
  },
  {
    slug: "pullup",
    name: "Pull-up bar",
    base_kg: null,
    step_kg: 2.5,
    discrete_values: null,
    bands: {},
  },
];

function ex(
  slug: string,
  type: CatalogExercise["type"],
  load_basis: CatalogExercise["load_basis"],
  equipment_slug: string | null,
): CatalogExercise {
  return {
    slug,
    name: slug,
    aliases: [],
    muscle_group: "x",
    type,
    load_basis,
    equipment_slug,
    is_main_lift: false,
    review_note: null,
  };
}

const EXERCISES: CatalogExercise[] = [
  ex("pull_up", "bodyweight_plus", "bodyweight_plus", "pullup"),
  ex("ring_row", "bodyweight_reps", null, null),
  ex("bench_press", "weighted", "barbell_total", "barbell"),
  ex("squat", "weighted", "barbell_total", "barbell"),
  ex("hack_squat", "weighted", "stack", "hack_squat"),
  ex("hanging_leg_raise", "bodyweight_reps", null, "pullup"),
  ex("hanging_knee_raise", "bodyweight_reps", null, "pullup"),
  ex("lateral_raise", "weighted", "per_hand", "dumbbells"),
  ex("cable_row", "weighted", "stack", "cable_stack"),
  ex("calisthenics_class", "class", null, null),
  ex("class_exposure", "class", null, null),
];

function item(
  week: number,
  weekday: Weekday,
  order: number,
  plan_name: string,
  options: string[],
  sets: [number, number] | null,
  reps: [number, number] | null,
): ParsedItem {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    key: `w${pad(week)}-${weekday}-${pad(order)}-0`,
    week,
    weekday,
    order,
    sub_item: 0,
    block: "Main",
    plan_name,
    exercise_options: options,
    variant_label: null,
    prescription_raw: "synthetic",
    extras_raw: null,
    sets_min: sets?.[0] ?? null,
    sets_max: sets?.[1] ?? null,
    reps_min: reps?.[0] ?? null,
    reps_max: reps?.[1] ?? null,
    per_side: false,
    duration_s_min: null,
    duration_s_max: null,
    hiit: null,
    tempo: null,
    modifiers: [],
    hspu_step: null,
    rir_min: null,
    rir_max: null,
    tags: [],
    rest_raw: "",
    priority: "High",
    note: null,
    time_raw: "10 min",
    time_min_min: 10,
    time_min_max: 10,
    fallback_prescription: null,
    flags: [],
  };
}

function weekItems(week: number): ParsedItem[] {
  return [
    item(week, "mon", 0, "Warm-up", ["calisthenics_class"], null, null),
    item(week, "mon", 1, "Clean strict pull-up", ["pull_up"], [4, 4], [3, 3]),
    item(week, "mon", 2, "Chest-supported row", ["ring_row"], [3, 3], [6, 8]),
    item(week, "mon", 3, "Bench press", ["bench_press"], [2, 2], [6, 8]),
    item(week, "mon", 4, "Squat / hack squat", ["squat", "hack_squat"], [3, 3], [6, 8]),
    item(
      week,
      "mon",
      5,
      "Hanging leg raise / knee raise",
      ["hanging_leg_raise", "hanging_knee_raise"],
      [2, 3],
      [8, 15],
    ),
    item(week, "mon", 6, "Lateral raise", ["lateral_raise"], [2, 2], [12, 15]),
    item(week, "mon", 7, "Cable row", ["cable_row"], [3, 3], [8, 10]),
    item(week, "mon", 8, "Weighted pull-up", ["pull_up"], [4, 4], [4, 6]),
    item(week, "tue", 0, "Hack squat solo", ["hack_squat"], [3, 3], [6, 8]),
    item(week, "fri", 0, "Full-body warm-up", ["calisthenics_class"], null, null),
    item(week, "thu", 0, "Calisthenics class", ["calisthenics_class"], null, null),
    item(week, "thu", 1, "Thursday exposure", ["class_exposure"], null, null),
  ];
}

export function planFixture(): ResolvedPlan {
  return {
    open_issues: [],
    resolved_hash: "synthetic-resolved",
    plan: {
      source_hash: "synthetic-source",
      name: PLAN_NAME,
      start_date: "2026-09-28",
      weeks_count: 3,
      weeks: [
        { week: 1, phase: "Base", is_deload: false, is_test: false, start_date: "2026-09-28" },
        { week: 2, phase: "Base", is_deload: false, is_test: false, start_date: "2026-10-05" },
        { week: 3, phase: "Base", is_deload: true, is_test: false, start_date: "2026-10-12" },
      ],
      equipment: EQUIPMENT,
      hspu_ladder: [],
      exercises: EXERCISES,
      items: [...weekItems(1), ...weekItems(2), ...weekItems(3)],
    },
  };
}

export const GOOD_OVERRIDES = {
  bodyweight: { date: "2026-09-28", kg: 70 },
  records: {
    "w01-mon-04": { chosen_option: "hack_squat" },
    "w01-mon-05": { chosen_option: "hanging_leg_raise" },
  },
};
