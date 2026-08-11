-- Correct the USDC token address seeded for Arbitrum Sepolia (chainId 421614).
-- The seed introduced in fd5265ae used 0xf3c3351d6bd0098eeb33ca8f830faf2a141ea2e1,
-- which is a deployed USDC-named ERC20 on Arbitrum Sepolia but is NOT Circle's
-- official testnet USDC. Circle's documented Arbitrum Sepolia USDC is
-- 0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d (see
-- https://developers.circle.com/stablecoins/usdc-on-test-networks). Wallets
-- holding the official Circle USDC therefore show a zero USDC balance because
-- the balances API queries balanceOf at the wrong contract.
--
-- Affected tables:
--   - supported_tokens: system-wide stablecoin list. Has unique constraint
--     supported_tokens_chain_address on (chain_id, token_address). Update in
--     place; bail out if a row with the new address already coexists.
--   - organization_tokens: per-org tracked tokens. No unique constraint on
--     (chain_id, token_address). If an org has BOTH the wrong and correct
--     rows (e.g. they manually added the right address), drop the wrong one
--     to avoid duplicates; otherwise update in place.
--
-- This migration deliberately contains no statement breakpoint markers so
-- drizzle-kit runs the whole file as a single query inside its implicit
-- per-migration transaction. Matches the precedent set by 0061.
--
-- IMPORTANT: do NOT write the drizzle breakpoint marker phrase verbatim
-- anywhere in this file -- not even inside comments or quoted strings.
-- drizzle-orm's readMigrationFiles does a context-free string split for
-- that phrase across the whole file, regardless of where it appears.

-- Precondition: refuse to run if both wrong and correct USDC rows already
-- coexist in supported_tokens. The unique constraint would block the UPDATE
-- in that case; a human should reconcile manually.
DO $$
BEGIN
  IF (SELECT count(*) FROM "supported_tokens"
        WHERE "chain_id" = 421614
          AND "token_address" = '0xf3c3351d6bd0098eeb33ca8f830faf2a141ea2e1') > 0
     AND (SELECT count(*) FROM "supported_tokens"
        WHERE "chain_id" = 421614
          AND "token_address" = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d') > 0 THEN
    RAISE EXCEPTION 'supported_tokens has rows for both wrong and correct Arbitrum Sepolia USDC; reconcile manually before running 0063.';
  END IF;
END$$;

-- Repoint the system-wide row at Circle's official Arbitrum Sepolia USDC.
UPDATE "supported_tokens"
   SET "token_address" = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'
 WHERE "chain_id" = 421614
   AND "token_address" = '0xf3c3351d6bd0098eeb33ca8f830faf2a141ea2e1';

-- Drop any per-org wrong-address rows for orgs that already track the correct
-- address, so the subsequent UPDATE cannot produce duplicate (org, chain,
-- address) tuples. There is no unique constraint here so the UPDATE alone
-- would not fail, but we want one canonical row per org.
DELETE FROM "organization_tokens" AS ot
 WHERE ot."chain_id" = 421614
   AND ot."token_address" = '0xf3c3351d6bd0098eeb33ca8f830faf2a141ea2e1'
   AND EXISTS (
     SELECT 1 FROM "organization_tokens" AS other
      WHERE other."organization_id" = ot."organization_id"
        AND other."chain_id" = 421614
        AND other."token_address" = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'
   );

UPDATE "organization_tokens"
   SET "token_address" = '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d'
 WHERE "chain_id" = 421614
   AND "token_address" = '0xf3c3351d6bd0098eeb33ca8f830faf2a141ea2e1';
