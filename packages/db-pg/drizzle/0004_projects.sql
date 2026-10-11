CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_channel" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "maintenance_window" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_org_idx" ON "project" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "alert_channel" ADD CONSTRAINT "alert_channel_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window" ADD CONSTRAINT "maintenance_window_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor" ADD CONSTRAINT "monitor_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "project" ("organization_id", "name") SELECT "id", 'Production' FROM "organization" o WHERE NOT EXISTS (SELECT 1 FROM "project" p WHERE p."organization_id" = o."id");
--> statement-breakpoint
UPDATE "monitor" SET "project_id" = (SELECT p."id" FROM "project" p WHERE p."organization_id" = "monitor"."organization_id" ORDER BY p."created_at" LIMIT 1) WHERE "project_id" IS NULL;
--> statement-breakpoint
UPDATE "status_page" SET "project_id" = (SELECT p."id" FROM "project" p WHERE p."organization_id" = "status_page"."organization_id" ORDER BY p."created_at" LIMIT 1) WHERE "project_id" IS NULL;
--> statement-breakpoint
UPDATE "alert_channel" SET "project_id" = (SELECT p."id" FROM "project" p WHERE p."organization_id" = "alert_channel"."organization_id" ORDER BY p."created_at" LIMIT 1) WHERE "project_id" IS NULL;
--> statement-breakpoint
UPDATE "maintenance_window" SET "project_id" = (SELECT p."id" FROM "project" p WHERE p."organization_id" = "maintenance_window"."organization_id" ORDER BY p."created_at" LIMIT 1) WHERE "project_id" IS NULL;
