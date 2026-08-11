-- KEEP-545: classification columns on workflow_executions so the SLA alert
-- (`keeperhub_workflow_execution_errors_created_total{is_user_error="false"}`)
-- can separate real DB/infra/engine failures from user-config noise without
-- depending on log-line text matching.
--
-- Nullable on purpose: existing rows stay null; new rows get classified at
-- finalization time by lib/errors/classify.ts. A separate backfill script
-- (scripts/backfill-error-classification.ts) populates managed-client rows
-- in last 90 days.
--
-- No partial index in this migration. A `CREATE INDEX CONCURRENTLY ON
-- workflow_executions (error_category) WHERE error_category IS NOT NULL`
-- is planned as a follow-up once the project's concurrent-index migrator
-- helper lands; the alert query filters on a Prometheus label, not the DB
-- column, so this PR does not need the index.
ALTER TABLE "workflow_executions" ADD COLUMN "error_category" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "is_user_error" boolean;
