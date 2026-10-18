CREATE TYPE "public"."data_source" AS ENUM('import', 'bot');--> statement-breakpoint
ALTER TABLE "bodyweight_logs" ALTER COLUMN "source" SET DATA TYPE "public"."data_source" USING "source"::"public"."data_source";--> statement-breakpoint
ALTER TABLE "class_logs" ALTER COLUMN "source" SET DATA TYPE "public"."data_source" USING "source"::"public"."data_source";--> statement-breakpoint
ALTER TABLE "weekly_metrics" ALTER COLUMN "source" SET DATA TYPE "public"."data_source" USING "source"::"public"."data_source";--> statement-breakpoint
ALTER TABLE "class_logs" ADD CONSTRAINT "class_logs_heavy_groups_valid" CHECK ("class_logs"."heavy_groups" <@ ARRAY['pull','push','legs']::text[]);