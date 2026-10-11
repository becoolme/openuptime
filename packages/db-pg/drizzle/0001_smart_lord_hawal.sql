CREATE TABLE "maintenance_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"monitor_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "keyword" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "keyword_mode" text DEFAULT 'contains' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "headers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "grace_sec" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "channel_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_window" ADD CONSTRAINT "maintenance_window_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_org_idx" ON "maintenance_window" USING btree ("organization_id","starts_at");