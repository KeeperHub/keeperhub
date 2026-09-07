-- @requires-db-prep
-- KEEP-1042: the two index lookups the retention purge depends on.
--
-- Both support a pass in lib/retention/purge-executions.ts. Without them the
-- job sequentially scans a 62 GB and an 8.8 GB table on every run, which is the
-- opposite of what a job that exists to protect the database should do.
--
-- 1. idx_workflow_executions_started_at
--    Pass 5 retires run rows past a flat window with `started_at < cutoff`.
--    workflow_executions has no index whose leading column is an unfiltered
--    started_at: idx_workflow_executions_workflow_started leads with
--    workflow_id, and the two billable_started indexes from 0135 are partial on
--    `billable = TRUE`, so neither can answer a plain range on started_at. The
--    pass matches nothing until the oldest row is past the window (400 days by
--    default, and the oldest row on prod is from 2026-01-06), but without the
--    index "matches nothing" costs a full scan every single run.
--    Cost: one more B-tree entry per insert. started_at is written once at
--    insert and never updated, so no update becomes non-HOT because of it.
--
-- 2. idx_exec_logs_deleted_at
--    Pass 4 hard-deletes step logs a user purged from the UI, which KEEP-1199
--    turned into a soft delete. Partial on `deleted_at IS NOT NULL`, so it
--    holds only the rows waiting out their grace period -- about 4.6k of 23M on
--    prod, roughly 0.02% -- instead of an entry per row of the table. It also
--    empties itself: once a row is hard-deleted its entry goes with it.
--
-- On large environments apply out-of-band as CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS (see the @requires-db-prep runbook). Both builds exceed the 120s
-- role-level statement_timeout, so that session needs SET statement_timeout = 0.
-- The transaction-safe form below then no-ops on deploy.
--
--   SET statement_timeout = 0;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_executions_started_at
--     ON workflow_executions USING btree (started_at);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exec_logs_deleted_at
--     ON workflow_execution_logs USING btree (deleted_at)
--     WHERE deleted_at IS NOT NULL;
--
-- Confirm both are present before setting the db-prepped label:
--   SELECT indexname FROM pg_indexes
--   WHERE indexname IN ('idx_workflow_executions_started_at',
--                       'idx_exec_logs_deleted_at');
--
-- No meta snapshot, matching 0150: these indexes are declared in raw SQL only,
-- the way idx_workflow_executions_workflow_started and the rest of the analytics
-- indexes from 0024 are.

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_started_at"
  ON "workflow_executions" USING btree ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_exec_logs_deleted_at"
  ON "workflow_execution_logs" USING btree ("deleted_at")
  WHERE "deleted_at" IS NOT NULL;
