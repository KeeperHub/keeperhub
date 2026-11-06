SET lock_timeout = '3s';

ALTER TABLE "alert_incidents" ADD COLUMN "opening_execution_id" text;--> statement-breakpoint
CREATE INDEX "idx_alert_incidents_opening_run" ON "alert_incidents" USING btree ("organization_id","opening_execution_id") WHERE "alert_incidents"."opening_execution_id" IS NOT NULL;