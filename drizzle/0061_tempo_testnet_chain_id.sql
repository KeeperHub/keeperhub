-- Correct Tempo testnet chainId from 42429 to 42431 per Tempo docs:
-- https://docs.tempo.xyz/quickstart/connection-details#testnet
-- Also fix explorer URL host: explorer.testnet.tempo.xyz -> explore.testnet.tempo.xyz
-- (matches the mainnet 'explore.mainnet.tempo.xyz' pattern).
--
-- Workflow node JSON stores the chainId as a numeric string in the per-node
-- `network` field (see components/workflow/config/chain-select-field.tsx).
-- Existing workflows pinned to Tempo testnet have "network":"42429" embedded
-- in workflows.nodes JSONB and in nested call-list entries. We rewrite both
-- top-level and nested occurrences via a regex over the JSONB text form,
-- scoped to the explicit "network":"42429" key/value pair so we cannot
-- accidentally rewrite unrelated literal strings.

-- This migration deliberately contains no statement breakpoint markers so
-- drizzle-kit runs the whole file as a single query inside its implicit
-- per-migration transaction (matches the precedent set by 0025). If any UPDATE
-- fails the FK drop is rolled back with it.
--
-- IMPORTANT: do NOT write the drizzle breakpoint marker phrase verbatim
-- anywhere in this file -- not even inside comments or quoted strings.
-- drizzle-orm's readMigrationFiles (drizzle-orm/src/migrator.ts) does a
-- context-free string split for that phrase across the whole file, which
-- shreds the migration into separate statements regardless of where the
-- phrase appears.

-- Precondition: refuse to run if any 42431 rows already coexist with 42429
-- rows in any of the affected tables. This avoids unique- or PK-collision
-- errors mid-migration (chains, explorer_configs, supported_tokens are
-- guarded by unique constraints; pending_transactions and wallet_locks by
-- composite primary keys). If both ids are present a human needs to
-- reconcile before this migration can run.
DO $$
BEGIN
  IF (SELECT count(*) FROM "chains" WHERE "chain_id" = 42429) > 0
     AND (SELECT count(*) FROM "chains" WHERE "chain_id" = 42431) > 0 THEN
    RAISE EXCEPTION 'Both chain_id 42429 and 42431 exist in chains; reconcile manually before running 0061.';
  END IF;
  IF (SELECT count(*) FROM "supported_tokens" WHERE "chain_id" = 42429) > 0
     AND (SELECT count(*) FROM "supported_tokens" WHERE "chain_id" = 42431) > 0 THEN
    RAISE EXCEPTION 'supported_tokens has rows for both 42429 and 42431; reconcile before running 0061.';
  END IF;
  IF (SELECT count(*) FROM "organization_tokens" WHERE "chain_id" = 42429) > 0
     AND (SELECT count(*) FROM "organization_tokens" WHERE "chain_id" = 42431) > 0 THEN
    RAISE EXCEPTION 'organization_tokens has rows for both 42429 and 42431; reconcile before running 0061.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "pending_transactions" a
    JOIN "pending_transactions" b
      ON a."wallet_address" = b."wallet_address" AND a."nonce" = b."nonce"
    WHERE a."chain_id" = 42429 AND b."chain_id" = 42431
  ) THEN
    RAISE EXCEPTION 'pending_transactions has colliding (wallet,nonce) rows across 42429 and 42431; reconcile before running 0061.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "wallet_locks" a
    JOIN "wallet_locks" b ON a."wallet_address" = b."wallet_address"
    WHERE a."chain_id" = 42429 AND b."chain_id" = 42431
  ) THEN
    RAISE EXCEPTION 'wallet_locks has colliding wallet rows across 42429 and 42431; reconcile before running 0061.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "user_rpc_preferences" a
    JOIN "user_rpc_preferences" b ON a."user_id" = b."user_id"
    WHERE a."chain_id" = 42429 AND b."chain_id" = 42431
  ) THEN
    RAISE EXCEPTION 'user_rpc_preferences has colliding (user_id,chain_id) rows across 42429 and 42431; reconcile before running 0061.';
  END IF;
END$$;

-- Drop the FK from explorer_configs.chain_id -> chains.chain_id so we can
-- update both sides; it is recreated at the end. The constraint is not
-- DEFERRABLE, so an in-place UPDATE on chains.chain_id would otherwise fail.
ALTER TABLE "explorer_configs"
  DROP CONSTRAINT "explorer_configs_chain_id_chains_chain_id_fk";

UPDATE "chains" SET "chain_id" = 42431 WHERE "chain_id" = 42429;

UPDATE "explorer_configs"
  SET "chain_id" = 42431,
      "explorer_url" = 'https://explore.testnet.tempo.xyz',
      "explorer_api_url" = 'https://explore.testnet.tempo.xyz/api',
      "updated_at" = now()
  WHERE "chain_id" = 42429;

-- Catch any explorer_configs row that already had chain_id=42431 (newly
-- seeded environments) but still has the stale explorer host.
UPDATE "explorer_configs"
  SET "explorer_url" = 'https://explore.testnet.tempo.xyz',
      "explorer_api_url" = 'https://explore.testnet.tempo.xyz/api',
      "updated_at" = now()
  WHERE "chain_id" = 42431
    AND ("explorer_url" = 'https://explorer.testnet.tempo.xyz'
      OR "explorer_api_url" = 'https://explorer.testnet.tempo.xyz/api');

UPDATE "supported_tokens" SET "chain_id" = 42431 WHERE "chain_id" = 42429;
UPDATE "organization_tokens" SET "chain_id" = 42431 WHERE "chain_id" = 42429;
UPDATE "user_rpc_preferences" SET "chain_id" = 42431 WHERE "chain_id" = 42429;
UPDATE "pending_transactions" SET "chain_id" = 42431 WHERE "chain_id" = 42429;
UPDATE "wallet_locks" SET "chain_id" = 42431 WHERE "chain_id" = 42429;

-- Rewrite embedded chainId strings in workflow node JSON. The pattern is
-- intentionally specific: only the "network":"42429" key/value pair, with
-- optional whitespace around the colon, is replaced. This covers both
-- node.data.config.network (top-level) and call-list entries[].network
-- (nested) without touching addresses, hashes, or labels.
UPDATE "workflows"
SET "nodes" = regexp_replace(
  "nodes"::text,
  '"network"\s*:\s*"42429"',
  '"network":"42431"',
  'g'
)::jsonb,
  "updated_at" = now()
WHERE "nodes"::text LIKE '%"42429"%';

-- direct_executions.network is a top-level text column; update in place.
UPDATE "direct_executions" SET "network" = '42431' WHERE "network" = '42429';

-- Note: workflow_executions.input/output/execution_trace and
-- workflow_execution_logs.input/output are historical run records; we leave
-- them untouched so audit trails remain accurate to what actually executed.

ALTER TABLE "explorer_configs"
  ADD CONSTRAINT "explorer_configs_chain_id_chains_chain_id_fk"
  FOREIGN KEY ("chain_id") REFERENCES "chains"("chain_id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;
