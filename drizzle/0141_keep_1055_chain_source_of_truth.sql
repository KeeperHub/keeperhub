-- chains becomes the single source of truth for chain classification.
--
-- lib/agentic-wallet/workflow-binding.ts previously hardcoded two shadow
-- structures of this table: DATA_CHAIN_SLUG_TO_ID (alias -> chainId) and
-- KNOWN_DATA_CHAIN_IDS (which enabled chainIds count as data chains).
-- Neither tracked chains.isEnabled, so disabling a chain here did nothing
-- to payment-binding classification, and Optimism (chainId 10, already
-- seeded) was silently absent from both. aliases and is_payment_rail let
-- classifyChainTag query this table directly instead.
--
-- ADD COLUMN with a constant default is metadata-only on PG11+ but still
-- takes a brief ACCESS EXCLUSIVE lock that queues behind long reads.
ALTER TABLE "chains" ADD COLUMN IF NOT EXISTS "aliases" jsonb DEFAULT '[]' NOT NULL;
ALTER TABLE "chains" ADD COLUMN IF NOT EXISTS "is_payment_rail" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill aliases for the vocabulary DATA_CHAIN_SLUG_TO_ID previously
-- hardcoded, plus Optimism (KEEP-1055's original "minor" gap: it is a
-- data chain, seeded here, but was never added to KNOWN_DATA_CHAIN_IDS).
UPDATE "chains" SET "aliases" = '["ethereum", "eth"]' WHERE "chain_id" = 1;
UPDATE "chains" SET "aliases" = '["optimism", "op"]' WHERE "chain_id" = 10;
UPDATE "chains" SET "aliases" = '["bnb", "bsc", "binance"]' WHERE "chain_id" = 56;
UPDATE "chains" SET "aliases" = '["polygon", "matic"]' WHERE "chain_id" = 137;
UPDATE "chains" SET "aliases" = '["arbitrum", "arbitrum-one"]' WHERE "chain_id" = 42161;
UPDATE "chains" SET "aliases" = '["avalanche", "avax"]' WHERE "chain_id" = 43114;
UPDATE "chains" SET "aliases" = '["plasma"]' WHERE "chain_id" = 9745;
UPDATE "chains" SET "aliases" = '["0g", "og", "aristotle"]' WHERE "chain_id" = 16661;
--> statement-breakpoint
-- Payment rails: KeeperHub's own settlement chains (Base, Tempo), as
-- opposed to the data chains above which a workflow only reads from.
-- Matches BASE_CHAIN_ID / TEMPO_MAINNET_CHAIN_ID / TEMPO_TESTNET_CHAIN_ID
-- in lib/agentic-wallet/constants.ts. The Tempo testnet id here (4218)
-- may not match any seeded row until KEEP-1062 (42431 vs 4218 mismatch)
-- is resolved -- this UPDATE is then a correct no-op for that row rather
-- than something to special-case.
UPDATE "chains" SET "aliases" = '["base"]', "is_payment_rail" = true WHERE "chain_id" = 8453;
UPDATE "chains" SET "aliases" = '["tempo"]', "is_payment_rail" = true WHERE "chain_id" IN (4217, 4218);
