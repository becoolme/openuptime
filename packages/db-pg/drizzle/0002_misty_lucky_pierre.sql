CREATE TABLE "status_subscriber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_subscriber" ADD CONSTRAINT "status_subscriber_status_page_id_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscriber_page_email_idx" ON "status_subscriber" USING btree ("status_page_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscriber_token_idx" ON "status_subscriber" USING btree ("token");