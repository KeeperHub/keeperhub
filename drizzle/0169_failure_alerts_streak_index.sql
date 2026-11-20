-- @requires-db-prep
-- Failure alerts: loadStreakRuns reads a workflow's newest counted runs. For a
-- workflow with millions of refused rows the plan walked an index over all of
-- its rows and filtered them out (~1.2 s per call on prod).
--
-- Partial: leaves out every row a streak cannot count (refused as skipped or
-- as an unpaid billing error, platform errors, unfinished, deleted); the
-- predicate is countedRunSql (lib/db/counted-runs.ts), which the query repeats
-- verbatim. Keyed on the expression the query sorts by, so no other index can
-- serve that order: with a plain (workflow_id, started_at) key the planner
-- kept choosing the existing indexes, since it cannot see that one workflow's
-- rows are nearly all refused. Measured locally with 400k refused rows on one
-- workflow: ~200 ms before, ~3 ms with this index, custom and generic plans.
--
-- DB-PREP: workflow_executions is the largest table. On staging and prod an
-- operator applies `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (same
-- definition) out-of-band before merge and checks no INVALID index is left,
-- so the plain statement below is a no-op there. On dev and PR-environment
-- databases it runs as written.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_workflow_started_counted" ON "workflow_executions" USING btree ("workflow_id",(CASE WHEN "status" <> 'skipped' THEN "started_at" END) DESC) WHERE ("workflow_executions"."status" <> 'skipped' AND "workflow_executions"."completed_at" IS NOT NULL AND "workflow_executions"."deleted_at" IS NULL
    AND ("workflow_executions"."status" <> 'error' OR ("workflow_executions"."error_type" IS DISTINCT FROM 'system'
      AND ("workflow_executions"."error_category" IS DISTINCT FROM 'billing' OR "workflow_executions"."billable"))));
