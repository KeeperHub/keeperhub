-- KEEP-395: partial composite index on workflow_execution_logs for executor
-- authority lookups.
--
-- The getCompletedStepOutput helper queries:
--   WHERE execution_id = $1 AND node_id = $2 AND status = 'success'
--
-- The existing idx_exec_logs_execution_id covers only (execution_id). Adding a
-- covering index on (execution_id, node_id) filtered to status='success' rows
-- eliminates heap rechecks for this specific hot read path. The partial filter
-- keeps the index small relative to the total table (~1/N of rows for an
-- N-status log table), which also keeps the build cheap.
--
-- Note on CONCURRENTLY: drizzle-kit migrate wraps each migration file in a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block. We accept a brief AccessExclusive lock on workflow_execution_logs
-- during the build (expected sub-second for the partial index on a typical
-- prod-sized table). If lock duration becomes an issue, run a manual
-- CONCURRENTLY rebuild post-deploy and DROP this index in a follow-up.
CREATE INDEX IF NOT EXISTS idx_exec_logs_success_lookup
  ON workflow_execution_logs (execution_id, node_id)
  WHERE status = 'success';
