-- @requires-db-prep
-- KEEP-669: reconcile the 2026-05-29 DB CPU incident indexes (PR #1402) and
-- add the durable covering indexes for /api/metrics/db.
--
-- Two distinct groups below:
--
-- GROUP A - reconciliation (already on prod, missing everywhere else).
--   During the incident, two partial composite indexes were created BY HAND
--   directly on prod (~19:14 UTC) to bring CPU down after the helm +
--   DB-migration rollback. They exist on prod but in no migration file, so
--   staging, PR envs and fresh clones are missing them - silent drift. These
--   statements capture the EXACT prod definitions; on prod the IF NOT EXISTS
--   clauses make them no-ops, on other envs they build the matching index.
--
-- GROUP B - durable fix (net-new on every environment, including prod).
--   The incident root cause was /api/metrics/db running unindexed aggregations
--   (getWorkflowStatsFromDb / getStepStatsFromDb) that seq-scanned
--   workflow_executions and workflow_execution_logs. These covering indexes
--   put the GROUP BY keys in the index and INCLUDE (duration) so both the
--   breakdown and the duration-histogram queries are satisfied by an
--   index-only scan - cost bounded by index size, not row count, instead of a
--   full parallel seq scan that grows linearly forever.
--
-- The `-- @requires-db-prep` directive blocks merge until an operator has
-- applied each index via `CREATE INDEX CONCURRENTLY IF NOT EXISTS` out-of-band
-- and set the `db-prepped-<target-branch>` label (same runbook as 0075).
-- This matters for GROUP B specifically: those are real builds, and
-- workflow_execution_logs is ~1.9 GB on prod - a plain in-transaction
-- CREATE INDEX would take an ACCESS EXCLUSIVE lock for the whole build and
-- risk a repeat incident. drizzle-kit wraps each migration in a transaction
-- and CONCURRENTLY cannot run in a transaction, hence the out-of-band step;
-- the IF NOT EXISTS clauses then make this migration a no-op on prod at deploy
-- time. On dev / PR-env DBs the tables are small so the plain CREATE INDEX is
-- sub-second.
--
-- Operator runbook (per target environment):
--   1. Connect to the target DB.
--   2. For each index NOT already present, run the statement as
--      `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one at a time, outside a
--      transaction block. (On prod, GROUP A already exists - only GROUP B
--      needs building.)
--   3. Verify no INVALID indexes were left behind:
--      SELECT relname FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid
--      WHERE NOT indisvalid;
--   4. Add the `db-prepped-<branch>` label to the PR.

-- GROUP A: reconcile manual incident indexes (verbatim prod definitions;
-- status IN (...) is Postgres's normalized form of status = ANY (ARRAY[...])).

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_status_duration"
  ON "workflow_executions" ("status", "duration")
  WHERE status IN ('success', 'error') AND duration IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_exec_logs_status_duration"
  ON "workflow_execution_logs" ("status", "duration")
  WHERE status IN ('success', 'error') AND duration IS NOT NULL;--> statement-breakpoint

-- GROUP B: durable covering indexes for /api/metrics/db aggregations.

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_stats_covering"
  ON "workflow_executions" ("status", "error_type", "workflow_id")
  INCLUDE ("duration");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_exec_logs_stats_covering"
  ON "workflow_execution_logs" ("node_type", "status")
  INCLUDE ("duration");
