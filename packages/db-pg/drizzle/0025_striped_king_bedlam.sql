ALTER TABLE "incident_update" ADD COLUMN "by_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "incident_update" SET "by_person" = true WHERE "author_id" IS NOT NULL;
