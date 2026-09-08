-- KEEP-857: denormalise per-step network + gas onto workflow_execution_logs.
--
-- The /analytics per-network gas breakdown (computeNetworkBreakdown) is the
-- last reader that still extracts `network` (input) and `gasUsed` (output) from
-- the double-encoded JSONB on every log row in the window, GROUP BY-ing and
-- SUM-ing those re-parsed expressions. That is unindexable and, on a large org
-- over a 30d range, runs past Cloudflare's 100s limit (the networks-endpoint
-- 524). Run-total gas was already denormalised onto workflow_executions
-- (KEEP-683); this does the same one level down, per step, because network is a
-- per-step property.
--
-- These columns let the breakdown read first-class columns with no JSONB parse.
-- network is populated at step start (from input), gas_used_wei at step
-- complete (from output) by lib/workflow/executor/logging.ts, and historical
-- rows are filled by scripts/backfill-exec-log-network-gas.ts.
--
-- No `-- @requires-db-prep`: ADD COLUMN of a nullable column with no default is
-- a catalog-only change in PostgreSQL 11+ (momentary ACCESS EXCLUSIVE lock, no
-- table rewrite), safe inline via the normal migrate path even on the large
-- prod logs table. The heavy backfill UPDATE runs out-of-band, batched.

ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "network" text;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "gas_used_wei" numeric;
