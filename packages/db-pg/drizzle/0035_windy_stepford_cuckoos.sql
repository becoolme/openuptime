ALTER TABLE "monitor" ADD COLUMN "recovery_threshold" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "consecutive_successes" integer DEFAULT 0 NOT NULL;