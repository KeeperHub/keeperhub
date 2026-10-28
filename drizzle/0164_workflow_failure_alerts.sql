CREATE TABLE "failure_alert_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text,
	"kind" text NOT NULL,
	"integration_id" text NOT NULL,
	"destination" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'always' NOT NULL,
	"paused_at" timestamp,
	"paused_reason" text,
	"last_delivered_at" timestamp,
	"last_failed_at" timestamp,
	"last_error" text,
	"last_tested_at" timestamp,
	"last_test_ok" boolean,
	"last_health_check_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failure_alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"incident_id" text,
	"kind" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"channel" text NOT NULL,
	"channel_id" text,
	"recipient" text NOT NULL,
	"is_backup" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"backup_at" timestamp,
	"backup_sent_at" timestamp,
	"last_status" integer,
	"last_error" text,
	"context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "failure_alert_email_usage" (
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "failure_alert_email_usage_organization_id_period_start_pk" PRIMARY KEY("organization_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "failure_alert_heartbeats" (
	"job" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp NOT NULL,
	"last_duration_ms" integer,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "org_failure_alert_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"threshold" integer DEFAULT 5 NOT NULL,
	"time_limit_minutes" integer,
	"remind_daily" boolean DEFAULT true NOT NULL,
	"notify_recovery" boolean DEFAULT true NOT NULL,
	"recipient_user_ids" jsonb,
	"counting_since" timestamp,
	"launch_notice_sent_at" timestamp,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_failure_alert_overrides" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"threshold" integer,
	"time_limit_minutes" integer,
	"recipient_user_ids" jsonb,
	"custom_channels" boolean DEFAULT false NOT NULL,
	"muted_until" timestamp,
	"mute_until_success" boolean DEFAULT false NOT NULL,
	"mute_reason" text,
	"muted_by" text,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_failure_alert_queue" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"due_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_failure_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"opened_by" text NOT NULL,
	"threshold" integer NOT NULL,
	"failure_count" integer NOT NULL,
	"first_failed_at" timestamp NOT NULL,
	"last_failed_at" timestamp NOT NULL,
	"last_failed_execution_id" text,
	"last_error" text,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"last_notified_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_reason" text,
	"resolving_execution_id" text
);
--> statement-breakpoint
ALTER TABLE "failure_alert_channels" ADD CONSTRAINT "failure_alert_channels_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_channels" ADD CONSTRAINT "failure_alert_channels_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_channels" ADD CONSTRAINT "failure_alert_channels_integration_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_deliveries" ADD CONSTRAINT "failure_alert_deliveries_incident_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."workflow_failure_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_deliveries" ADD CONSTRAINT "failure_alert_deliveries_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_email_usage" ADD CONSTRAINT "failure_alert_email_usage_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_failure_alert_settings" ADD CONSTRAINT "org_failure_alert_settings_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_alert_overrides" ADD CONSTRAINT "workflow_failure_alert_overrides_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_alert_overrides" ADD CONSTRAINT "workflow_failure_alert_overrides_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_incidents" ADD CONSTRAINT "workflow_failure_incidents_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_incidents" ADD CONSTRAINT "workflow_failure_incidents_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_failure_alert_channels_org" ON "failure_alert_channels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_failure_alert_channels_workflow" ON "failure_alert_channels" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_failure_alert_deliveries_message" ON "failure_alert_deliveries" USING btree ("organization_id","incident_id","kind","sequence","channel","recipient","is_backup");--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_due" ON "failure_alert_deliveries" USING btree ("next_attempt_at") WHERE "failure_alert_deliveries"."state" IN ('pending', 'retrying', 'sending');--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_org_created" ON "failure_alert_deliveries" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_failure_alert_queue_due" ON "workflow_failure_alert_queue" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_failure_incidents_open" ON "workflow_failure_incidents" USING btree ("workflow_id") WHERE "workflow_failure_incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_workflow_failure_incidents_org" ON "workflow_failure_incidents" USING btree ("organization_id");--> statement-breakpoint
-- Mark a workflow for the failure-alert evaluator whenever one of its runs
-- reaches a final success or error. Every code path that ends a run writes
-- this table, so one trigger covers all of them. The evaluator decides
-- whether the run counts (manual runs do not); this only queues.
--
-- It must never stop a run from finishing: any error is swallowed, and the
-- evaluator's backstop sweep re-checks recent failures the queue missed.
CREATE OR REPLACE FUNCTION public.queue_workflow_failure_alert_check()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO workflow_failure_alert_queue (workflow_id, due_at)
    VALUES (NEW.workflow_id, now())
    ON CONFLICT (workflow_id) DO UPDATE
      SET due_at = now()
      WHERE workflow_failure_alert_queue.due_at > now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'queue_workflow_failure_alert_check failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS queue_workflow_failure_alert_check ON workflow_executions;
--> statement-breakpoint
CREATE TRIGGER queue_workflow_failure_alert_check
  AFTER INSERT OR UPDATE OF status ON workflow_executions
  FOR EACH ROW
  WHEN (NEW.status IN ('success', 'error'))
  EXECUTE FUNCTION public.queue_workflow_failure_alert_check();
