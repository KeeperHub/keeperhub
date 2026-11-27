-- LOCAL and reset at the end: drizzle-kit runs all pending files in one transaction,
-- so this timeout covers only this file's statements.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Lock workflow_executions first (deployed with 0172/0173, their ShareLock on it is
-- already held). A not_landed run also queues the alert check (it proves the workflow
-- runs). Drop and create in one transaction: no gap without the trigger, and no PG 14+ syntax.
DROP TRIGGER IF EXISTS queue_alert_check ON workflow_executions;
--> statement-breakpoint
CREATE TRIGGER queue_alert_check
  AFTER INSERT OR UPDATE OF status ON workflow_executions
  FOR EACH ROW
  WHEN (NEW.status IN ('success', 'error', 'skipped', 'not_landed'))
  EXECUTE FUNCTION public.queue_alert_check();
--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "bundle_builders" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD COLUMN "last_target_block" bigint;--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD COLUMN "bundle_runs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
