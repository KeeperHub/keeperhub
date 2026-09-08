CREATE TABLE "execution_quota_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"threshold" integer NOT NULL,
	"usage_percent" integer NOT NULL,
	"executions_used" integer NOT NULL,
	"execution_limit" integer NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_quota_notif_org_period_threshold" UNIQUE("organization_id","period_start","threshold")
);
--> statement-breakpoint
ALTER TABLE "execution_quota_notifications" ADD CONSTRAINT "execution_quota_notif_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_quota_notif_org" ON "execution_quota_notifications" USING btree ("organization_id");