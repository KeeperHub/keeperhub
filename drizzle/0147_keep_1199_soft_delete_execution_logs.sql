-- @requires-db-prep
-- Every statement is idempotent because the operator applies this whole file
-- to the target DB by hand before merge. The index needs organization_id to
-- exist, so the column and the constraint have to be run out of band with it,
-- and the deploy then re-runs all four statements as a no-op.
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
-- NOT VALID skips the validation scan, which would take a SHARE ROW EXCLUSIVE
-- lock on workflow_executions during deploy. The constraint still enforces on
-- every new insert; only pre-existing rows go unchecked, and those are all
-- NULL until the backfill runs. Operator runs VALIDATE CONSTRAINT after it.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workflow_executions_organization_id_organization_id_fk'
      AND conrelid = 'public.workflow_executions'::regclass
  ) THEN
    ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- The index backs that FK. Without it the RI check on an organization delete
-- or key change scans workflow_executions, the largest table, under lock. The
-- operator creates it CONCURRENTLY, so IF NOT EXISTS makes this statement a
-- no-op on deploy and it never takes the ACCESS EXCLUSIVE lock a plain
-- CREATE INDEX would hold for the length of the build.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_organization_id" ON "workflow_executions" ("organization_id");
