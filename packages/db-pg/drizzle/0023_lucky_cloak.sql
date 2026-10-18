CREATE TYPE "public"."incident_update_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "root_cause" text;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "postmortem" text;--> statement-breakpoint
ALTER TABLE "incident_update" ADD COLUMN "visibility" "incident_update_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "incident_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing incidents join their monitor's project (workspace-level ones the oldest project) and are numbered by start time.
UPDATE "incident" SET "project_id" = m."project_id" FROM "monitor" m WHERE m."id" = "incident"."monitor_id";--> statement-breakpoint
UPDATE "incident" SET "project_id" = (SELECT p."id" FROM "project" p WHERE p."organization_id" = "incident"."organization_id" ORDER BY p."created_at", p."id" LIMIT 1) WHERE "project_id" IS NULL;--> statement-breakpoint
UPDATE "incident" SET "number" = n."rn" FROM (SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "started_at", "id") AS "rn" FROM "incident" WHERE "project_id" IS NOT NULL) n WHERE n."id" = "incident"."id";--> statement-breakpoint
UPDATE "project" SET "incident_seq" = COALESCE((SELECT max("number") FROM "incident" WHERE "incident"."project_id" = "project"."id"), 0);--> statement-breakpoint
CREATE UNIQUE INDEX "incident_project_number_idx" ON "incident" USING btree ("project_id","number");