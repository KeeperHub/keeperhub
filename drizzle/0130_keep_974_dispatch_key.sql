-- @requires-db-prep
-- KEEP-974: dispatch-idempotency key for the schedule/block dispatchers.
--
-- The dispatchers now run two replicas with leader election. To guarantee no
-- duplicate SQS dispatch across failover / rolling restart, each dispatched
-- occurrence carries a stable dispatch_key
-- (schedule:<scheduleId>:<occurrenceIso> / block:<workflowId>:<chainId>:<blockNumber>).
-- The create-phantom insert is ON CONFLICT DO NOTHING on the unique index
-- below, so an overlapping leader or a catch-up window that re-runs an
-- occurrence collides and skips its enqueue instead of creating a second run.
-- NULL keys (manual/webhook/direct rows) are treated as distinct by Postgres
-- and never collide.
--
-- The column ADD is cheap. The UNIQUE index build is the reason for the
-- @requires-db-prep gate: workflow_executions is a multi-million-row table, so
-- on prod/staging an operator builds it CONCURRENTLY out-of-band before merge
-- (CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ...); the plain statement
-- below is then a no-op (IF NOT EXISTS). On dev / PR-env DBs the table is small
-- so the in-migration build is fine. The new column is entirely NULL at build
-- time, so the unique build cannot find a duplicate.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "dispatch_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflow_executions_dispatch_key"
  ON "workflow_executions" ("dispatch_key");
