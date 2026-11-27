-- @requires-db-prep
-- Failure alerts: loadStreakRuns (failure streak, without notLanded) reads a
-- workflow's newest counted runs but leaves out not_landed ones. On 0169's index
-- that is a heap filter, so a workflow whose bundles keep missing re-reads its
-- whole not_landed tail on every run end. Same key and predicate as 0169, plus
-- the status <> 'not_landed' the query repeats verbatim.
-- Write cost: one more B-tree entry per counted run insert and per non-HOT
-- finalize on workflow_executions, as 0169's near-copy already costs.
--
-- DB-PREP: workflow_executions is the largest table. On staging and prod an
-- operator applies `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (same
-- definition) out-of-band before merge and checks no INVALID index is left,
-- so the plain statement below is a no-op there. On dev and PR-environment
-- databases it runs as written.
-- The plain statement still waits for ShareLock even when the index exists: bound the
-- wait, as 0174 does. Skip the SET lines in db-prep (they only act in a transaction).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_workflow_started_landed" ON "workflow_executions" USING btree ("workflow_id",(CASE WHEN "status" <> 'skipped' THEN "started_at" END) DESC) WHERE ("workflow_executions"."status" <> 'skipped' AND "workflow_executions"."completed_at" IS NOT NULL AND "workflow_executions"."deleted_at" IS NULL
    AND ("workflow_executions"."status" <> 'error' OR ("workflow_executions"."error_type" IS DISTINCT FROM 'system'
      AND ("workflow_executions"."error_category" IS DISTINCT FROM 'billing' OR "workflow_executions"."billable")))) AND "workflow_executions"."status" <> 'not_landed';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
