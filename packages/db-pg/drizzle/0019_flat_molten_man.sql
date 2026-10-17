ALTER TABLE "incident" ADD COLUMN "evaluation_note" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "depends_on_monitor_id" uuid;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "min_regions_failing" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_depends_on_monitor_id_monitor_id_fk" FOREIGN KEY ("depends_on_monitor_id") REFERENCES "public"."monitor"("id") ON DELETE set null ON UPDATE no action;