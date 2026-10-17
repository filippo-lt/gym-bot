import type { CatalogExercise, Tag } from "./types.js";

function ex(
  slug: string,
  name: string,
  muscle_group: string,
  type: CatalogExercise["type"],
  load_basis: CatalogExercise["load_basis"],
  equipment_slug: string | null,
  is_main_lift: boolean,
  extra: { aliases?: string[]; review_note?: string } = {},
): CatalogExercise {
  return {
    slug,
    name,
    aliases: extra.aliases ?? [],
    muscle_group,
    type,
    load_basis,
    equipment_slug,
    is_main_lift,
    review_note: extra.review_note ?? null,
  };
}

export const CATALOG: CatalogExercise[] = [
  ex("pull_up", "Pull-up", "back", "bodyweight_plus", "bodyweight_plus", "pullup", true, {
    aliases: ["Clean strict pull-up", "Weighted pull-up", "Clean pull-up TEST"],
  }),
  ex("hspu", "HSPU", "shoulders", "skill_ladder", null, null, false, {
    aliases: ["HSPU progression", "handstand push-up"],
  }),
  ex("handstand", "Handstand", "shoulders", "skill_practice", null, null, false, {
    aliases: ["Handstand practice"],
  }),
  ex(
    "overhead_press",
    "Overhead press",
    "shoulders",
    "weighted",
    "barbell_total",
    "barbell",
    true,
    {
      aliases: ["OHP", "military press"],
    },
  ),
  ex("bench_press", "Bench press", "chest", "weighted", "barbell_total", "barbell", true, {
    aliases: ["bench"],
  }),
  ex(
    "romanian_deadlift",
    "Romanian deadlift",
    "hamstrings",
    "weighted",
    "barbell_total",
    "barbell",
    true,
    {
      aliases: ["RDL"],
    },
  ),
  ex("squat", "Squat", "quads", "weighted", "barbell_total", "barbell", true, {
    aliases: ["back squat"],
  }),
  ex("hack_squat", "Hack squat", "quads", "weighted", "stack", "hack_squat", true),
  ex(
    "chest_supported_row",
    "Chest-supported row",
    "back",
    "weighted",
    "per_hand",
    "dumbbells",
    false,
    {
      review_note: "Dumbbells per hand, or a machine stack?",
    },
  ),
  ex("cable_row", "Cable row", "back", "weighted", "stack", "cable_stack", false),
  ex("machine_row", "Machine row", "back", "weighted", "stack", "row_machine", false),
  ex("lat_pulldown", "Lat pulldown", "back", "weighted", "stack", "cable_stack", false, {
    aliases: ["pulldown"],
  }),
  ex("incline_db_bench", "Incline DB bench", "chest", "weighted", "per_hand", "dumbbells", false, {
    aliases: ["incline dumbbell bench"],
  }),
  ex(
    "bulgarian_split_squat",
    "Bulgarian split squat",
    "quads",
    "weighted",
    "per_hand",
    "dumbbells",
    false,
    {
      aliases: ["Bulgarian"],
    },
  ),
  ex("lateral_raise", "Lateral raise", "shoulders", "weighted", "per_hand", "dumbbells", false),
  ex("face_pull", "Face pull", "rear delts", "weighted", "stack", "cable_stack", false),
  ex("curl", "Curl", "biceps", "weighted", "per_hand", "dumbbells", false, {
    review_note:
      "Curl (dumbbells, per hand) and triceps extension (cable stack) equipment is a guess — confirm both",
  }),
  ex(
    "triceps_extension",
    "Triceps extension",
    "triceps",
    "weighted",
    "stack",
    "cable_stack",
    false,
  ),
  ex("hanging_leg_raise", "Hanging leg raise", "core", "bodyweight_reps", null, "pullup", false),
  ex("hanging_knee_raise", "Hanging knee raise", "core", "bodyweight_reps", null, "pullup", false),
  ex("dead_hang", "Dead hang", "grip", "timed", null, "pullup", false),
  ex("bike_hiit", "Bike HIIT", "cardio", "hiit", null, null, false),
  ex("bike_warmup", "Bike warm-up", "cardio", "warmup", null, null, false),
  ex("bike_cooldown", "Bike cool-down", "cardio", "warmup", null, null, false),
  ex("pull_warmup", "Pull warm-up", "full body", "warmup", null, null, false),
  ex("push_handstand_warmup", "Push + handstand warm-up", "full body", "warmup", null, null, false),
  ex("full_body_warmup", "Full-body warm-up", "full body", "warmup", null, null, false),
  ex("wrists_shoulders", "Wrists + shoulders", "mobility", "mobility", null, null, false),
  ex("thoracic_hips_ankles", "Thoracic + hips + ankles", "mobility", "mobility", null, null, false),
  ex(
    "hamstrings_hip_flexors",
    "Hamstrings + hip flexors",
    "mobility",
    "mobility",
    null,
    null,
    false,
  ),
  ex("full_body_recovery", "Full-body recovery", "full body", "recovery", null, null, false),
  ex("calisthenics_class", "Calisthenics class", "full body", "class", null, null, false),
  ex("class_exposure", "Thursday exposure", "full body", "class", null, null, false),
];

export interface PlanNameEntry {
  options: string[];
  tags: Tag[];
  variant_label: string | null;
}

function entry(options: string[], tags: Tag[], variant_label: string | null = null): PlanNameEntry {
  return { options, tags, variant_label };
}

const PULL_UP_TAGS: Tag[] = ["skill_strength", "vertical_pull"];

export const PLAN_NAME_MAP: Record<string, PlanNameEntry> = {
  "Clean strict pull-up": entry(["pull_up"], PULL_UP_TAGS),
  "Clean strict pull-up — deload": entry(["pull_up"], PULL_UP_TAGS, "deload"),
  "Weighted pull-up": entry(["pull_up"], PULL_UP_TAGS, "weighted"),
  "Weighted pull-up*": entry(["pull_up"], PULL_UP_TAGS, "weighted"),
  "Weighted pull-up — deload*": entry(["pull_up"], PULL_UP_TAGS, "weighted_deload"),
  "Clean pull-up TEST": entry(["pull_up"], PULL_UP_TAGS, "test"),
  "HSPU progression": entry(["hspu"], ["skill_strength", "vertical_press"]),
  "Handstand practice": entry(["handstand"], ["skill_practice"]),
  "Overhead press": entry(["overhead_press"], ["vertical_press"]),
  "Bench press": entry(["bench_press"], ["horizontal_press"]),
  "Romanian deadlift": entry(["romanian_deadlift"], ["hinge"]),
  "Squat / hack squat": entry(["squat", "hack_squat"], ["squat"]),
  "Chest-supported row": entry(["chest_supported_row"], ["row"]),
  "Cable / machine row": entry(["cable_row", "machine_row"], ["row"]),
  "Lat pulldown": entry(["lat_pulldown"], ["vertical_pull"]),
  "Incline DB bench": entry(["incline_db_bench"], ["horizontal_press"]),
  "Bulgarian split squat": entry(["bulgarian_split_squat"], ["unilateral_leg"]),
  "Lateral raise": entry(["lateral_raise"], ["accessory"]),
  "Face pull": entry(["face_pull"], ["prehab"]),
  "Curl OR triceps extension": entry(["curl", "triceps_extension"], ["accessory"]),
  "Hanging leg raise / knee raise": entry(["hanging_leg_raise", "hanging_knee_raise"], ["core"]),
  "Easy press back-off": entry(
    ["overhead_press", "bench_press"],
    ["vertical_press", "horizontal_press"],
  ),
  "Easy pull-down / hang": entry(["lat_pulldown", "dead_hang"], ["vertical_pull"]),
  "Bike HIIT": entry(["bike_hiit"], ["hiit"]),
  "Bike warm-up": entry(["bike_warmup"], ["warmup"]),
  "Bike cool-down": entry(["bike_cooldown"], ["warmup"]),
  "Pull warm-up": entry(["pull_warmup"], ["warmup"]),
  "Push + handstand warm-up": entry(["push_handstand_warmup"], ["warmup"]),
  "Full-body warm-up": entry(["full_body_warmup"], ["warmup"]),
  "Wrists + shoulders": entry(["wrists_shoulders"], ["mobility"]),
  "Thoracic + hips + ankles": entry(["thoracic_hips_ankles"], ["mobility"]),
  "Hamstrings + hip flexors": entry(["hamstrings_hip_flexors"], ["mobility"]),
  "Full-body recovery": entry(["full_body_recovery"], ["recovery"]),
  "Calisthenics class": entry(["calisthenics_class"], ["class"]),
  "Thursday exposure": entry(["class_exposure"], ["class"]),
};

/** The only plan names that are OR items. A slash anywhere else is never an OR. */
export const OR_PLAN_NAMES: ReadonlySet<string> = new Set([
  "Squat / hack squat",
  "Cable / machine row",
  "Curl OR triceps extension",
  "Hanging leg raise / knee raise",
  "Easy pull-down / hang",
  "Easy press back-off",
]);

/** OR plan names whose options are stated in the prescription text ("OHP or bench: …"). */
export const TEXT_OPTION_PLAN_NAMES: ReadonlySet<string> = new Set(["Easy press back-off"]);

export const CATALOG_BY_SLUG: ReadonlyMap<string, CatalogExercise> = new Map(
  CATALOG.map((c) => [c.slug, c]),
);
