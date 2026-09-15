-- @requires-db-prep
-- Supports the cutoff of the DevKit run retention job
-- (lib/retention/purge-devkit-runs.ts), which selects finished runs by
-- created_at in batches. Without it every batch scans workflow.workflow_runs.
--
-- The `workflow` schema belongs to @workflow/world-postgres, not to these
-- migrations. The deploy job runs its bootstrap before db:migrate, but a fresh
-- local setup runs db:migrate first, so the index is only created when the
-- table already exists.
DO $$
BEGIN
  IF to_regclass('workflow.workflow_runs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "idx_workflow_runs_created_at"
      ON "workflow"."workflow_runs" USING btree ("created_at");
  END IF;
END
$$;
