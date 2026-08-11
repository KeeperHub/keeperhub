-- @requires-db-prep
-- KEEP-857: supporting index for the per-network gas breakdown.
--
-- computeNetworkBreakdown's workflow branch filters
-- `gas_used_wei IS NOT NULL` over a started_at window, then GROUP BY network.
-- Gas-bearing step rows (web3 nodes) are a small fraction of all log rows, so a
-- partial index on started_at keyed to gas-bearing rows turns the window scan
-- into an index range scan that skips the non-gas majority.
--
-- DB-PREP: on prod/staging an operator applies this CONCURRENTLY out-of-band
-- (`CREATE INDEX CONCURRENTLY IF NOT EXISTS ...`) before merge, so the plain
-- statement below is a no-op there (IF NOT EXISTS). On dev / PR-env DBs the
-- table is small, so the plain in-migration build is fine.
CREATE INDEX IF NOT EXISTS "idx_exec_logs_gas_started_at"
  ON "workflow_execution_logs" ("started_at")
  WHERE gas_used_wei IS NOT NULL;
