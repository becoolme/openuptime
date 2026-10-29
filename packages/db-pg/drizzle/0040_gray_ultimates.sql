ALTER TYPE "public"."monitor_type" ADD VALUE 'domain';--> statement-breakpoint
CREATE TABLE "rdap_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "domain_expiry_warn_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "domain_expiry" jsonb;--> statement-breakpoint
CREATE INDEX "rdap_cache_expiry_idx" ON "rdap_cache" USING btree ("expires_at");