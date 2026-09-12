-- @requires-db-prep
-- KEEP-1042: the three index lookups the retention purge depends on.
--
-- Each supports a pass in lib/retention/purge-executions.ts. Without them the
-- job sequentially scans a 62 GB and an 8.8 GB table on every run, which is the
-- opposite of what a job that exists to protect the database should do.
--
-- 1. idx_workflow_executions_started_at
--    The run-row pass retires executions past a flat window with
--    `started_at < cutoff`. workflow_executions has no index whose leading
--    column is an unfiltered started_at: idx_workflow_executions_workflow_started
--    leads with workflow_id, and the two billable_started indexes from 0135 are
--    partial on `billable = TRUE`, so neither can answer a plain range on
--    started_at. That pass matches nothing until the oldest row is past the
--    window (400 days by default; the oldest row on prod is from 2026-01-06),
--    but without the index "matches nothing" costs a full scan every run.
--    Cost: one more B-tree entry per insert. started_at is written once at
--    insert and never updated, so no update becomes non-HOT because of it.
--
-- 2. idx_exec_logs_deleted_at
--    The soft-delete pass hard-deletes step logs a user purged from the UI,
--    which KEEP-1199 turned into a soft delete. Partial on
--    `deleted_at IS NOT NULL`, so it holds only the rows waiting out their
--    grace period -- about 4.6k of 23M on prod, roughly 0.02% -- instead of an
--    entry per row of the table. It also empties itself: once a row is
--    hard-deleted its entry goes with it.
--
-- 3. idx_exec_logs_output_raw_pending
--    The output_raw pass nulls the unredacted payload copy once a run can no
--    longer resume. It has no lower bound on started_at, because a bounded
--    slice only ever caught rows that crossed the boundary in the last few
--    days and left every older row untouched -- 19M rows and 14 GB of prod that
--    nothing would ever have reached. Unbounded needs this index to stay cheap:
--    it is partial on `output_raw IS NOT NULL`, so it self-prunes. It holds
--    ~19M entries while the backlog drains and settles at only the rows younger
--    than the window (~2M), which is why the unbounded scan stays cheap once
--    there is no work left. An UPDATE that nulls the column writes no new entry
--    and the old one dies with the tuple version.
--    Cost: one entry per insert on a hot table, removed by vacuum a week later.
--
-- On large environments apply out-of-band as CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS (see the @requires-db-prep runbook). The builds exceed the 120s
-- role-level statement_timeout, so that session needs SET statement_timeout = 0.
-- The transaction-safe form below then no-ops on deploy. Index 3 is the slow one
-- -- it indexes ~19M rows on a 62 GB table on first build.
--
--   SET statement_timeout = 0;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workflow_executions_started_at
--     ON workflow_executions USING btree (started_at);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exec_logs_deleted_at
--     ON workflow_execution_logs USING btree (deleted_at)
--     WHERE deleted_at IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exec_logs_output_raw_pending
--     ON workflow_execution_logs USING btree (started_at)
--     WHERE output_raw IS NOT NULL;
--
-- Confirm all three are present, and valid, before setting the db-prepped label:
--   SELECT indexrelid::regclass::text, indisvalid FROM pg_index
--   WHERE indexrelid::regclass::text IN ('idx_workflow_executions_started_at',
--                                        'idx_exec_logs_deleted_at',
--                                        'idx_exec_logs_output_raw_pending');
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_exec_logs_output_raw_pending"
  ON "workflow_execution_logs" USING btree ("started_at")
  WHERE "output_raw" IS NOT NULL;
