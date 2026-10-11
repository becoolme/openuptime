CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_rollup" (
	"monitor_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"latency_sum" bigint DEFAULT 0 NOT NULL,
	"latency_n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "check_rollup_monitor_id_bucket_pk" PRIMARY KEY("monitor_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "slow_threshold_ms" integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "slow_alert_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "consecutive_slow" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_setting" ADD COLUMN "check_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rollup" ADD CONSTRAINT "check_rollup_monitor_id_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "check_rollup" ("monitor_id","bucket","total","ok","latency_sum","latency_n")
SELECT monitor_id, date_trunc('hour', checked_at), count(*)::int, (count(*) filter (where ok))::int,
  coalesce(sum(latency_ms),0)::bigint, (count(latency_ms))::int
FROM check_result GROUP BY monitor_id, date_trunc('hour', checked_at)
ON CONFLICT DO NOTHING;
