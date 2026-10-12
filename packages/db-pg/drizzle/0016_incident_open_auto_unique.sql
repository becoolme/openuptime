-- two checks racing could each open an incident for the same outage: keep the oldest open one of each kind, resolve the rest
UPDATE "incident" SET "status" = 'resolved', "resolved_at" = now()
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "monitor_id", ("severity" = 'minor') ORDER BY "started_at", "id") AS rn
    FROM "incident" WHERE "auto" AND "resolved_at" IS NULL AND "monitor_id" IS NOT NULL
  ) d WHERE d.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "incident_open_auto_idx" ON "incident" USING btree ("monitor_id",("severity" = 'minor')) WHERE "incident"."auto" and "incident"."resolved_at" is null and "incident"."monitor_id" is not null;
