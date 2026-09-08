-- Surface on-chain transaction hashes in workflow execution responses.
--
-- Workflow executions can produce multiple transaction hashes (approve+swap,
-- fan-out transfers, For-Each loops over a write step). Previously the hash
-- existed only inside per-node output rows reachable via the /logs endpoint,
-- so consumers polling /status had to walk that endpoint and parse per-node
-- output to recover any hash. Naive clients that stopped on status='completed'
-- shipped undefined hashes downstream.
--
-- Each entry is a TransactionHashEntry object:
--   { hash, nodeId, nodeName, chainId?, network?, iterationIndex? }
-- carrying enough context for clients to render readable receipt lists
-- without a second /logs call. iterationIndex is present only on entries
-- produced inside a For-Each iteration (mirrors workflow_execution_logs:
-- "null for non-loop nodes").
--
-- Default '[]'::jsonb so historical rows read as "no hashes recorded at the
-- top level" rather than NULL - reconstructable on demand from
-- workflow_execution_logs.output_raw if backfill is ever needed.

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "transaction_hashes" jsonb NOT NULL DEFAULT '[]'::jsonb;
