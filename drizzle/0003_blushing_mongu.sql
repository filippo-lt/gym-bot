CREATE TYPE "public"."inbox_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "chat_lease" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"owner" uuid,
	"until" timestamp with time zone DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_lease" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"update_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "inbox_status" DEFAULT 'pending' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "inbox_update_id_unique" UNIQUE("update_id")
);
--> statement-breakpoint
ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "inbox_chat_status_update_idx" ON "inbox" USING btree ("chat_id","status","update_id");--> statement-breakpoint
CREATE INDEX "inbox_open_idx" ON "inbox" USING btree ("chat_id","update_id") WHERE "inbox"."status" IN ('pending', 'processing');