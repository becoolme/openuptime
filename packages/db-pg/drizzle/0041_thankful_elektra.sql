ALTER TYPE "public"."monitor_type" ADD VALUE 'mcp';--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "mcp_config" jsonb;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "mcp_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "mcp_observation" jsonb;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "mcp_generation" integer DEFAULT 0 NOT NULL;