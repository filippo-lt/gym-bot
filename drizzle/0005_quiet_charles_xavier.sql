CREATE TYPE "public"."proposal_kind" AS ENUM('hspu_advance', 'earlier_deload');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('open', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."readiness_log_source" AS ENUM('button', 'chat', 'derived');--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "proposal_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"message_id" integer
);
--> statement-breakpoint
ALTER TABLE "proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "readiness_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"source" "readiness_log_source" NOT NULL,
	"level" text,
	"exercise_id" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readiness_logs_kind_valid" CHECK ("readiness_logs"."kind" IN ('button_tired', 'button_ok', 'button_strong', 'chat_bad_sleep', 'chat_sore', 'chat_exhausted', 'recovery_low', 'drift')),
	CONSTRAINT "readiness_logs_level_valid" CHECK ("readiness_logs"."level" IS NULL OR "readiness_logs"."level" IN ('GREEN', 'YELLOW', 'RED'))
);
--> statement-breakpoint
ALTER TABLE "readiness_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_date" date NOT NULL,
	"planned_item_id" integer NOT NULL,
	"sub_item" integer DEFAULT 0 NOT NULL,
	"exercise_id" integer NOT NULL,
	"sets" integer NOT NULL,
	"reps_min" integer NOT NULL,
	"reps_max" integer NOT NULL,
	"rir_min" numeric(3, 1) NOT NULL,
	"rir_max" numeric(3, 1) NOT NULL,
	"rir_mid" numeric(3, 1) NOT NULL,
	"load_kg" numeric(6, 2),
	"added_kg" numeric(6, 2),
	"assist_kg" numeric(6, 2),
	"band" text,
	"system_load" numeric(6, 2),
	"e1rm_used" numeric(6, 2),
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"readiness_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_slot_unique" UNIQUE("session_date","planned_item_id","sub_item","exercise_id"),
	CONSTRAINT "suggestions_readiness_valid" CHECK ("suggestions"."readiness_level" IS NULL OR "suggestions"."readiness_level" IN ('GREEN', 'YELLOW', 'RED'))
);
--> statement-breakpoint
ALTER TABLE "suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pullup_gate_open" boolean DEFAULT false NOT NULL,
	"pullup_gate_since" date,
	"last_bw_max" integer,
	"hspu_step_id" integer,
	"hspu_pad_height" numeric(5, 1),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_state_single_row" CHECK ("user_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "user_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "log_entries" ADD COLUMN "band" text;--> statement-breakpoint
ALTER TABLE "log_groups" ADD COLUMN "suggestion_id" integer;--> statement-breakpoint
ALTER TABLE "readiness_logs" ADD CONSTRAINT "readiness_logs_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_state" ADD CONSTRAINT "user_state_hspu_step_id_hspu_ladder_id_fk" FOREIGN KEY ("hspu_step_id") REFERENCES "public"."hspu_ladder"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_kind_status_idx" ON "proposals" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "readiness_logs_date_idx" ON "readiness_logs" USING btree ("date");--> statement-breakpoint
ALTER TABLE "log_groups" ADD CONSTRAINT "log_groups_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE set null ON UPDATE no action;