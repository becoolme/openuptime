CREATE TABLE "server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"monitor_id" uuid,
	"machine_id" text NOT NULL,
	"name" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"kernel" text DEFAULT '' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"cpu_model" text DEFAULT '' NOT NULL,
	"cores" integer DEFAULT 0 NOT NULL,
	"mem_total" bigint DEFAULT 0 NOT NULL,
	"swap_total" bigint DEFAULT 0 NOT NULL,
	"boot_time" timestamp with time zone,
	"agent_version" text DEFAULT '' NOT NULL,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_agent_key" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "server_agent_key_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "server_metric" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu" double precision DEFAULT 0 NOT NULL,
	"mem_used" bigint DEFAULT 0 NOT NULL,
	"mem_cached" bigint DEFAULT 0 NOT NULL,
	"swap_used" bigint DEFAULT 0 NOT NULL,
	"disk_used" bigint DEFAULT 0 NOT NULL,
	"disk_total" bigint DEFAULT 0 NOT NULL,
	"disk_read_bps" double precision DEFAULT 0 NOT NULL,
	"disk_write_bps" double precision DEFAULT 0 NOT NULL,
	"net_rx_bps" double precision DEFAULT 0 NOT NULL,
	"net_tx_bps" double precision DEFAULT 0 NOT NULL,
	"load1" double precision DEFAULT 0 NOT NULL,
	"load5" double precision DEFAULT 0 NOT NULL,
	"load15" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server" ADD CONSTRAINT "server_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_agent_key" ADD CONSTRAINT "server_agent_key_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_agent_key" ADD CONSTRAINT "server_agent_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_metric" ADD CONSTRAINT "server_metric_server_id_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_machine_unique" ON "server" USING btree ("project_id","machine_id");--> statement-breakpoint
CREATE INDEX "server_org_idx" ON "server" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "server_metric_server_ts_idx" ON "server_metric" USING btree ("server_id","ts");--> statement-breakpoint
CREATE INDEX "server_metric_ts_idx" ON "server_metric" USING btree ("ts");