CREATE TABLE "mcp_alert_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"event_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"monitor_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"channel_id" uuid,
	"event" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"quota_attempted" boolean DEFAULT false NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_result" ADD COLUMN "mcp" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_alert_outbox" ADD CONSTRAINT "mcp_alert_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_alert_outbox" ADD CONSTRAINT "mcp_alert_outbox_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_alert_outbox" ADD CONSTRAINT "mcp_alert_outbox_delivery_id_alert_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."alert_delivery"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_alert_outbox_event_recipient_idx" ON "mcp_alert_outbox" USING btree ("event_key","recipient");--> statement-breakpoint
CREATE INDEX "mcp_alert_outbox_due_idx" ON "mcp_alert_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "mcp_alert_outbox_order_idx" ON "mcp_alert_outbox" USING btree ("monitor_id","recipient","sequence");