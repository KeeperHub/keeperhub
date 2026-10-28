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
	"dedup_key" text NOT NULL,
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
CREATE TABLE "org_failure_alert_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"threshold" integer DEFAULT 5 NOT NULL,
	"time_limit_minutes" integer,
	"remind_daily" boolean DEFAULT true NOT NULL,
	"notify_recovery" boolean DEFAULT true NOT NULL,
	"recipient_user_ids" jsonb,
	"counting_since" timestamp,
	"launch_notice_sent_at" timestamp,
	"paused_until" timestamp,
	"pause_reason" text,
	"paused_by" text,
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
	"pause_workflow" boolean DEFAULT false NOT NULL,
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
	"alert_queued_at" timestamp,
	"workflow_paused_at" timestamp,
	"workflow_resumed_at" timestamp,
	"resolved_at" timestamp,
	"resolved_reason" text,
	"resolving_execution_id" text
);
--> statement-breakpoint
ALTER TABLE "failure_alert_channels" ADD CONSTRAINT "failure_alert_channels_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_channels" ADD CONSTRAINT "failure_alert_channels_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_deliveries" ADD CONSTRAINT "failure_alert_deliveries_incident_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."workflow_failure_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_deliveries" ADD CONSTRAINT "failure_alert_deliveries_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_alert_email_usage" ADD CONSTRAINT "failure_alert_email_usage_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_failure_alert_settings" ADD CONSTRAINT "org_failure_alert_settings_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_alert_overrides" ADD CONSTRAINT "workflow_failure_alert_overrides_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_alert_overrides" ADD CONSTRAINT "workflow_failure_alert_overrides_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_incidents" ADD CONSTRAINT "workflow_failure_incidents_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_failure_incidents" ADD CONSTRAINT "workflow_failure_incidents_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_failure_alert_channels_destination" ON "failure_alert_channels" USING btree ("organization_id",coalesce("workflow_id", ''),"integration_id","destination");--> statement-breakpoint
CREATE INDEX "idx_failure_alert_channels_workflow" ON "failure_alert_channels" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_failure_alert_deliveries_dedup" ON "failure_alert_deliveries" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_incident" ON "failure_alert_deliveries" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_backup_due" ON "failure_alert_deliveries" USING btree ("backup_at") WHERE "failure_alert_deliveries"."is_backup" = false AND "failure_alert_deliveries"."backup_sent_at" IS NULL AND "failure_alert_deliveries"."state" IN ('pending', 'retrying', 'sending', 'failed', 'capped');--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_due" ON "failure_alert_deliveries" USING btree ("next_attempt_at") WHERE "failure_alert_deliveries"."state" IN ('pending', 'retrying', 'sending');--> statement-breakpoint
CREATE INDEX "idx_failure_alert_deliveries_org_created" ON "failure_alert_deliveries" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_failure_alert_queue_due" ON "workflow_failure_alert_queue" USING btree ("due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_failure_incidents_open" ON "workflow_failure_incidents" USING btree ("workflow_id") WHERE "workflow_failure_incidents"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_workflow_failure_incidents_org" ON "workflow_failure_incidents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_failure_incidents_workflow" ON "workflow_failure_incidents" USING btree ("workflow_id");--> statement-breakpoint
-- Mark a workflow for the failure-alert evaluator whenever one of its runs
-- reaches a final success or error. Every code path that ends a run writes
-- this table, so one trigger covers all of them. The evaluator decides
-- whether the run counts (manual runs do not); this only queues.
--
-- It must never stop a run from finishing, so any error is swallowed with a
-- warning in the Postgres log. A run missed that way is counted when the
-- workflow's next run ends, since the evaluator reads the whole streak from
-- run history rather than counting queue entries.
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
--> statement-breakpoint
-- Record when a workflow its failure incident paused is turned back on, by
-- any path (editor, API, MCP, admin): the incident then stops holding it, so
-- turning it off again later is the owner's own pause. Errors are swallowed
-- like the run trigger's, so an Enable switch can never fail because of this.
CREATE OR REPLACE FUNCTION public.mark_failure_incident_resumed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    UPDATE workflow_failure_incidents
      SET workflow_resumed_at = now()
      WHERE workflow_id = NEW.id
        AND resolved_at IS NULL
        AND workflow_paused_at IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'mark_failure_incident_resumed failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS mark_failure_incident_resumed ON workflows;
--> statement-breakpoint
CREATE TRIGGER mark_failure_incident_resumed
  AFTER UPDATE OF enabled ON workflows
  FOR EACH ROW
  WHEN (OLD.enabled = false AND NEW.enabled = true)
  EXECUTE FUNCTION public.mark_failure_incident_resumed();
