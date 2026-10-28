ALTER TABLE "maintenance_window" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_window" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
CREATE INDEX "maintenance_series_idx" ON "maintenance_window" USING btree ("organization_id","series_id");