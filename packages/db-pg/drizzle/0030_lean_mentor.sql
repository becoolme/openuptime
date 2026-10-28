CREATE TABLE "monitor_observation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"monitor_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"valid_until" timestamp with time zone,
	"maintenance_until" timestamp with time zone,
	"revision" integer NOT NULL,
	"generation" integer,
	"interval_sec" integer,
	"grace_sec" integer,
	"timeout_ms" integer
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "coverage_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "coverage_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "coverage_heartbeat_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_observation" ADD CONSTRAINT "monitor_observation_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_observation_time_idx" ON "monitor_observation" USING btree ("monitor_id","observed_at","id");