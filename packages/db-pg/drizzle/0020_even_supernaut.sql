ALTER TABLE "alert_delivery" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "status_message" text;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "next_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "reminder_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "escalation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "next_escalation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reminder_interval_min" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reminder_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "escalation" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "alert_delivery_status_idx" ON "alert_delivery" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_incident_idx" ON "alert_delivery" USING btree ("incident_id");