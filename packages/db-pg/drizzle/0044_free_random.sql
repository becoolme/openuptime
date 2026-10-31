CREATE TABLE "mcp_oauth_lease" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_lease" ADD CONSTRAINT "mcp_oauth_lease_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;