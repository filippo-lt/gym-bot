CREATE TYPE "public"."log_source" AS ENUM('text', 'voice', 'photo', 'import');--> statement-breakpoint
CREATE TYPE "public"."readiness_level" AS ENUM('GREEN', 'YELLOW', 'RED');--> statement-breakpoint
CREATE TYPE "public"."session_item_source" AS ENUM('bot', 'import');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('planned', 'done', 'modified', 'skipped');--> statement-breakpoint
CREATE TABLE "bodyweight_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"kg" numeric(5, 2) NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "bodyweight_logs_date_unique" UNIQUE("date")
);
--> statement-breakpoint
ALTER TABLE "bodyweight_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "class_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"raw_text" text,
	"photo_file_id" text,
	"parsed" jsonb,
	"heavy_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "class_logs_date_unique" UNIQUE("date")
);
--> statement-breakpoint
ALTER TABLE "class_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "log_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"set_index" integer NOT NULL,
	"reps" integer,
	"load_kg" numeric(6, 2),
	"added_kg" numeric(6, 2),
	"assist_kg" numeric(6, 2),
	"duration_s" integer,
	"distance_m" numeric,
	"pad_height" numeric(5, 1),
	"rir" numeric(3, 1),
	"rir_plus" boolean DEFAULT false NOT NULL,
	"clean" boolean,
	"note" text,
	CONSTRAINT "log_entries_group_set_unique" UNIQUE("group_id","set_index")
);
--> statement-breakpoint
ALTER TABLE "log_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "log_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_date" date NOT NULL,
	"performed_at" timestamp with time zone NOT NULL,
	"planned_item_id" integer,
	"sub_item" integer DEFAULT 0 NOT NULL,
	"exercise_id" integer NOT NULL,
	"bw_kg" numeric(5, 2),
	"readiness_level" "readiness_level",
	"source" "log_source" NOT NULL,
	"import_row_key" text,
	"per_set_unknown" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_groups_import_row_key_unique" UNIQUE("import_row_key")
);
--> statement-breakpoint
ALTER TABLE "log_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_date" date NOT NULL,
	"planned_item_id" integer NOT NULL,
	"status" "session_status" NOT NULL,
	"chosen_exercise_id" integer,
	"note" text,
	"source" "session_item_source" NOT NULL,
	"import_row_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_items_import_row_key_unique" UNIQUE("import_row_key"),
	CONSTRAINT "session_items_date_item_unique" UNIQUE("session_date","planned_item_id")
);
--> statement-breakpoint
ALTER TABLE "session_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "weekly_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_week" integer NOT NULL,
	"metric" text NOT NULL,
	"value_num" numeric,
	"value_text" text,
	"unit" text,
	"source" text NOT NULL,
	"import_row_key" text,
	CONSTRAINT "weekly_metrics_import_row_key_unique" UNIQUE("import_row_key"),
	CONSTRAINT "weekly_metrics_week_metric_unique" UNIQUE("plan_week","metric")
);
--> statement-breakpoint
ALTER TABLE "weekly_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_group_id_log_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."log_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_groups" ADD CONSTRAINT "log_groups_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_groups" ADD CONSTRAINT "log_groups_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_items" ADD CONSTRAINT "session_items_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_items" ADD CONSTRAINT "session_items_chosen_exercise_id_exercises_id_fk" FOREIGN KEY ("chosen_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;