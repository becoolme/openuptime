ALTER TABLE "monitor" ADD COLUMN "dns_record_type" text DEFAULT 'A' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "dns_expected_value" text;--> statement-breakpoint
ALTER TABLE "monitor" ADD COLUMN "dns_match_mode" text DEFAULT 'exact' NOT NULL;