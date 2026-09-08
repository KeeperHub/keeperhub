-- Scan results cache table for the DeFi position scanner (Phase 51).
-- One row per lowercased EVM address stores the full multi-chain scan
-- result as a JSONB blob. TTL is enforced via expires_at; the Phase 55
-- cron sweeper deletes rows older than 1 hour. Cache reads filter
-- WHERE expires_at > NOW() (5-minute TTL on write).
-- Idempotent: safe to re-run on a DB that already has the table.
CREATE TABLE IF NOT EXISTS scan_results (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  result_json JSONB NOT NULL,
  scanned_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);
-- UNIQUE: address is the cache key + the upsert (ON CONFLICT) target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_results_address
  ON scan_results (address);
CREATE INDEX IF NOT EXISTS idx_scan_results_expires
  ON scan_results (expires_at);
