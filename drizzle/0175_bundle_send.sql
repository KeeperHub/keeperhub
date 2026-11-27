-- LOCAL and reset at the end: drizzle-kit runs all pending files in one transaction,
-- so this timeout covers only this file's statements.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- A not_landed run also queues the alert check (it proves the workflow runs). A
-- second trigger, so queue_alert_check is left as it is: CREATE TRIGGER takes
-- SHARE ROW EXCLUSIVE, which readers do not block (DROP TRIGGER would take
-- ACCESS EXCLUSIVE). Lock workflow_executions first, as 0173/0174 already do.
CREATE TRIGGER queue_alert_check_not_landed
  AFTER INSERT OR UPDATE OF status ON workflow_executions
  FOR EACH ROW
  WHEN (NEW.status = 'not_landed')
  EXECUTE FUNCTION public.queue_alert_check();
--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD COLUMN "last_target_block" bigint;--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD COLUMN "bundle_runs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
