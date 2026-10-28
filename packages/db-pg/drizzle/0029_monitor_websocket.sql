ALTER TYPE "public"."monitor_type" ADD VALUE 'websocket';--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "ws_message" text;