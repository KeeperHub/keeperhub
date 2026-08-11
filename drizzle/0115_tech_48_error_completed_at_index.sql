-- @requires-db-prep
-- TECH-48: supporting index for the per-workflow managed-client error gauge.
--
-- getWorkflowErrorsByWorkflowFromDb runs on every /api/metrics/db scrape and
-- filters `status = 'error' AND completed_at >= now() - interval '1 hour'`.
-- With no index on completed_at, Postgres found error rows via the status
-- index (which matches EVERY error execution across all orgs) and only then
-- filtered by time + joined to the managed orgs -- a heavy scan that tripped
-- the 8s metrics statement_timeout (Postgres 57014). The catch returned [],
-- so keeperhub_workflow_errors_by_workflow flapped (series vanished on most
-- scrapes). A partial index on completed_at (status = 'error') turns the
-- rolling-1h lookup into an index range scan that finishes in milliseconds.
--
-- DB-PREP: on prod/staging an operator applies this CONCURRENTLY out-of-band
-- (`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`) before merge, so the plain
-- statement below is a no-op there (IF NOT EXISTS). On dev / PR-env DBs the
-- table is small, so the plain in-migration build is fine.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_error_completed_at"
  ON "workflow_executions" ("completed_at")
  WHERE status = 'error';
