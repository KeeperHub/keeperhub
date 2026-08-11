-- @requires-db-prep
-- KEEP-1039 / KEEP-1040: indexes for the billable-execution counts.
--
-- Every billing count over workflow_executions shares one predicate:
-- started_at within a window AND billable = TRUE. There are two distinct
-- access patterns and they want different leading columns, hence two indexes.
--
-- Note idx_workflow_executions_workflow_started (workflow_id, started_at DESC)
-- from 0024 already exists and is NOT sufficient: billable is not in it, so
-- counting an org's month means a heap fetch per matching row to test billable.
-- On the org that triggered the 2026-07-26 staging incident that was ~1.6M
-- random heap fetches over a 40 GB table, which exceeded the statement timeout.
-- Both indexes below are partial on billable so the count needs no heap access
-- at all (subject to the visibility map being current).
--
-- INDEX A - per-org counts over a window. Serves the executor + app billing
--   guard (lib/billing/execution-limit-core.ts), the invoice usage figures
--   (lib/billing/execution-usage.ts) and overage billing (lib/billing/overage.ts).
--   Leading workflow_id so the org's workflow set drives the scan.
--
-- INDEX B - the platform-wide 30-day rollup grouped by org in
--   getBillingStatsFromDb (lib/metrics/db-metrics.ts). That query has no org
--   filter, so INDEX A does not serve it; it needs started_at leading to range
--   scan the window, with workflow_id carried as a payload column to join to
--   workflows without touching the heap. This is the query whose failure blanked
--   the billing gauges during the incident.
--
-- Cost: two more B-tree inserts per execution row on a hot table. Accepted
-- because both queries are otherwise O(rows) with heap access and the table now
-- grows monotonically (KEEP-1035 made history purges a soft delete).
--
-- On large environments apply out-of-band as CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS (see the @requires-db-prep runbook); these transaction-safe forms then
-- no-op on deploy.

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_billable_workflow_started"
  ON "workflow_executions" ("workflow_id", "started_at")
  WHERE billable = TRUE;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_billable_started"
  ON "workflow_executions" ("started_at")
  INCLUDE ("workflow_id")
  WHERE billable = TRUE;
