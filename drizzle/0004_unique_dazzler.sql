CREATE TYPE "public"."memory_kind" AS ENUM('alias', 'preference', 'limitation', 'weekly_summary');--> statement-breakpoint
CREATE TYPE "public"."pending_kind" AS ENUM('confirm', 'clarify_exercise', 'delete');--> statement-breakpoint
CREATE TYPE "public"."pending_status" AS ENUM('open', 'executed', 'cancelled', 'replaced', 'expired');--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_role_valid" CHECK ("conversation_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"content" text NOT NULL,
	"structured" jsonb,
	"confirmed" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"kind" "pending_kind" NOT NULL,
	"actions" jsonb NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "pending_status" DEFAULT 'open' NOT NULL,
	"awaiting_edit" boolean DEFAULT false NOT NULL,
	"message_id" integer,
	"source_update_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"stt_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "write_ledger" (
	"source_key" text NOT NULL,
	"action_index" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "write_ledger_source_key_action_index_pk" PRIMARY KEY("source_key","action_index")
);
--> statement-breakpoint
ALTER TABLE "write_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "log_groups" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "log_groups" ADD COLUMN "hspu_step_id" integer;--> statement-breakpoint
CREATE INDEX "conversation_messages_chat_created_idx" ON "conversation_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_items_active_alias_unique" ON "memory_items" USING btree (("structured"->>'alias')) WHERE "memory_items"."kind" = 'alias' AND "memory_items"."active";--> statement-breakpoint
CREATE INDEX "pending_actions_chat_status_idx" ON "pending_actions" USING btree ("chat_id","status");--> statement-breakpoint
CREATE INDEX "usage_logs_date_idx" ON "usage_logs" USING btree ("date");--> statement-breakpoint
ALTER TABLE "log_groups" ADD CONSTRAINT "log_groups_hspu_step_id_hspu_ladder_id_fk" FOREIGN KEY ("hspu_step_id") REFERENCES "public"."hspu_ladder"("id") ON DELETE no action ON UPDATE no action;