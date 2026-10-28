ALTER TABLE "monitor" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "import_source_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_import_source_unique" ON "monitor" USING btree ("organization_id","project_id","import_source","import_source_id");