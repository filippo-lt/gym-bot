CREATE TABLE "session_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_date" date NOT NULL,
	"planned_item_id" integer NOT NULL,
	"replaced_exercise_id" integer NOT NULL,
	"replacement_exercise_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_overrides_slot_unique" UNIQUE("session_date","planned_item_id","replaced_exercise_id")
);
--> statement-breakpoint
ALTER TABLE "session_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD COLUMN "change" jsonb;--> statement-breakpoint
ALTER TABLE "session_overrides" ADD CONSTRAINT "session_overrides_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_overrides" ADD CONSTRAINT "session_overrides_replaced_exercise_id_exercises_id_fk" FOREIGN KEY ("replaced_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_overrides" ADD CONSTRAINT "session_overrides_replacement_exercise_id_exercises_id_fk" FOREIGN KEY ("replacement_exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_overrides_planned_item_id_idx" ON "session_overrides" USING btree ("planned_item_id");--> statement-breakpoint
CREATE INDEX "session_overrides_replacement_exercise_id_idx" ON "session_overrides" USING btree ("replacement_exercise_id");