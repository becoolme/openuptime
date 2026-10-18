ALTER TABLE "monitor" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "incident_monitor_idx" ON "incident" USING btree ("monitor_id","started_at");--> statement-breakpoint
CREATE INDEX "incident_update_incident_idx" ON "incident_update" USING btree ("incident_id","created_at");