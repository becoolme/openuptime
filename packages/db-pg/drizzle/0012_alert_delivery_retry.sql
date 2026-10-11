ALTER TABLE "alert_delivery" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_delivery" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "alert_delivery_retry_idx" ON "alert_delivery" USING btree ("next_attempt_at");