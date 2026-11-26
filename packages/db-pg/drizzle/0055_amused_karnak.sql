ALTER TABLE "check_result" ADD COLUMN "false_alarm_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "false_alarm_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "false_alarm_reason" text;--> statement-breakpoint
ALTER TABLE "incident" ADD COLUMN "false_alarm_by_id" text;--> statement-breakpoint
ALTER TABLE "incident" ADD CONSTRAINT "incident_false_alarm_by_id_user_id_fk" FOREIGN KEY ("false_alarm_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_result_false_alarm_idx" ON "check_result" USING btree ("false_alarm_incident_id") WHERE "check_result"."false_alarm_incident_id" is not null;