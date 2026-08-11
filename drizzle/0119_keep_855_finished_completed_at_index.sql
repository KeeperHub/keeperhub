-- @requires-db-prep
-- KEEP-855: supporting index for the fast "zero finished executions" alert.
--
-- getLastFinishedExecutionAgeSecondsFromDb runs on every /api/metrics/db scrape
-- and computes max(completed_at) over workflow_executions where completed_at
-- IS NOT NULL. The existing partial index on completed_at only covers
-- status = 'error', so a max() over ALL finished rows has no usable index and
-- Postgres would scan the whole multi-million-row table on every scrape, risking
-- the 8s metrics statement_timeout (Postgres 57014). A partial index on
-- completed_at (completed_at IS NOT NULL) turns max() into a single-row backward
-- index scan that finishes in microseconds.
--
-- DB-PREP: on prod/staging an operator applies this CONCURRENTLY out-of-band
-- (`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`) before merge, so the plain
-- statement below is a no-op there (IF NOT EXISTS). On dev / PR-env DBs the
-- table is small, so the plain in-migration build is fine.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_completed_at"
  ON "workflow_executions" ("completed_at")
  WHERE completed_at IS NOT NULL;
