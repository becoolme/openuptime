CREATE TABLE "maintenance_reminder" (
	"maintenance_id" uuid NOT NULL,
	"status_page_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_reminder_maintenance_id_status_page_id_pk" PRIMARY KEY("maintenance_id","status_page_id")
);
--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "uptime_ok_pct" double precision DEFAULT 99.9 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "uptime_warn_pct" double precision DEFAULT 98 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "mcp_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "status_page" ADD COLUMN "maintenance_reminder_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "status_subscriber" ADD COLUMN "monitor_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_setting" ADD COLUMN "monthly_report" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_setting" ADD COLUMN "last_report_month" text;--> statement-breakpoint
ALTER TABLE "maintenance_reminder" ADD CONSTRAINT "maintenance_reminder_maintenance_id_maintenance_window_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenance_window"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_reminder" ADD CONSTRAINT "maintenance_reminder_status_page_id_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;