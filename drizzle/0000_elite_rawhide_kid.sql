CREATE TYPE "public"."exercise_type" AS ENUM('weighted', 'bodyweight_plus', 'bodyweight_reps', 'skill_ladder', 'timed', 'distance', 'skill_practice', 'hiit', 'mobility', 'warmup', 'class', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."load_basis" AS ENUM('barbell_total', 'per_hand', 'stack', 'bodyweight_plus');--> statement-breakpoint
CREATE TYPE "public"."weekday" AS ENUM('mon', 'tue', 'wed', 'thu', 'fri');--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"base_kg" numeric(6, 2),
	"step_kg" numeric(6, 2),
	"discrete_values" numeric(6, 2)[],
	"bands" jsonb,
	CONSTRAINT "equipment_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "equipment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"muscle_group" text NOT NULL,
	"type" "exercise_type" NOT NULL,
	"load_basis" "load_basis",
	"equipment_id" integer,
	"is_main_lift" boolean NOT NULL,
	CONSTRAINT "exercises_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "exercises" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hspu_ladder" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"step_order" integer NOT NULL,
	"default_sets" integer,
	"default_reps_min" integer,
	"default_reps_max" integer,
	"tempo" text,
	CONSTRAINT "hspu_ladder_slug_unique" UNIQUE("slug"),
	CONSTRAINT "hspu_ladder_step_order_unique" UNIQUE("step_order")
);
--> statement-breakpoint
ALTER TABLE "hspu_ladder" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text NOT NULL,
	"source_hash" text NOT NULL,
	"resolved_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_versions_plan_id_version_unique" UNIQUE("plan_id","version")
);
--> statement-breakpoint
ALTER TABLE "plan_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plan_weeks" (
	"plan_version_id" integer NOT NULL,
	"week" integer NOT NULL,
	"phase" text NOT NULL,
	"is_deload" boolean NOT NULL,
	"is_test" boolean NOT NULL,
	"start_date" date NOT NULL,
	CONSTRAINT "plan_weeks_plan_version_id_week_pk" PRIMARY KEY("plan_version_id","week")
);
--> statement-breakpoint
ALTER TABLE "plan_weeks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "planned_item_options" (
	"planned_item_id" integer NOT NULL,
	"exercise_id" integer NOT NULL,
	"option_index" integer NOT NULL,
	CONSTRAINT "planned_item_options_planned_item_id_option_index_pk" PRIMARY KEY("planned_item_id","option_index")
);
--> statement-breakpoint
ALTER TABLE "planned_item_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "planned_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_version_id" integer NOT NULL,
	"item_key" text NOT NULL,
	"week" integer NOT NULL,
	"weekday" "weekday" NOT NULL,
	"item_order" integer NOT NULL,
	"sub_item" integer NOT NULL,
	"block" text NOT NULL,
	"plan_name" text NOT NULL,
	"variant_label" text,
	"prescription_raw" text NOT NULL,
	"extras_raw" text,
	"sets_min" integer,
	"sets_max" integer,
	"reps_min" integer,
	"reps_max" integer,
	"per_side" boolean NOT NULL,
	"duration_s_min" integer,
	"duration_s_max" integer,
	"hiit" jsonb,
	"tempo" text,
	"modifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"hspu_step_id" integer,
	"rir_min" numeric(3, 1),
	"rir_max" numeric(3, 1),
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"rest_raw" text NOT NULL,
	"priority" text NOT NULL,
	"note" text,
	"time_raw" text NOT NULL,
	"time_min_min" integer,
	"time_min_max" integer,
	"fallback_prescription" jsonb,
	CONSTRAINT "planned_items_slot_unique" UNIQUE("plan_version_id","week","weekday","item_order","sub_item"),
	CONSTRAINT "planned_items_key_unique" UNIQUE("plan_version_id","item_key")
);
--> statement-breakpoint
ALTER TABLE "planned_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"weeks" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_weeks" ADD CONSTRAINT "plan_weeks_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_item_options" ADD CONSTRAINT "planned_item_options_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_item_options" ADD CONSTRAINT "planned_item_options_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_hspu_step_id_hspu_ladder_id_fk" FOREIGN KEY ("hspu_step_id") REFERENCES "public"."hspu_ladder"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_item_options_exercise_id_idx" ON "planned_item_options" USING btree ("exercise_id");