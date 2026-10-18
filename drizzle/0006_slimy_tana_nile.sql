CREATE TYPE "public"."job_status" AS ENUM('claimed', 'done');--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"date" date NOT NULL,
	"status" "job_status" DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "input_source" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN "transcript" text;--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_job_date_unique" ON "job_runs" USING btree ("job","date");--> statement-breakpoint
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_input_source_valid" CHECK ("pending_actions"."input_source" IN ('text', 'voice', 'photo'));