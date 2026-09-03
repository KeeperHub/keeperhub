-- @requires-db-prep
-- KEEP-1308: bookkeeping only, no new index on any deployed environment.
--
-- idx_exec_logs_execution_id has existed since 0024_analytics-indexes.sql, but
-- it was never declared in lib/db/schema.ts. The reaper's correlated NOT EXISTS
-- probes it once per reap candidate, so the dependency needs to live where the
-- next person looks for it. This migration only records the index drizzle-kit
-- now expects; every environment that ran 0024 already has it.
--
-- The directive on line 1 makes db-prep-check.yml block merge until the
-- matching db-prepped-<target-branch> label is set. Confirm the index is
-- present in the target environment before you set it:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'workflow_execution_logs'
--     AND indexname = 'idx_exec_logs_execution_id';
-- IF NOT EXISTS then short-circuits before any lock. drizzle-kit emits a bare
-- CREATE INDEX, which would take an ACCESS EXCLUSIVE lock on a 22 GB table.
CREATE INDEX IF NOT EXISTS "idx_exec_logs_execution_id"
  ON "workflow_execution_logs" USING btree ("execution_id");
