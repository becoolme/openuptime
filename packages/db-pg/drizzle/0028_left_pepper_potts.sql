ALTER TABLE "monitor" ADD COLUMN "run_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "last_run_generation" integer DEFAULT 0 NOT NULL;