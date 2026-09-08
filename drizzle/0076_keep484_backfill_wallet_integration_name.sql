-- KEEP-484: backfill truncated wallet integration names.
--
-- Historical web3 integration rows stored `name` as a UI-truncated display
-- string like `0x5623...960C` (containing literal `...`), produced by
-- `truncateAddress()` in lib/db/integrations.ts:buildWalletIntegrationPayload.
-- External clients fetching `GET /api/integrations` mistook the value for a
-- real address and passed it verbatim as `onBehalfOf` to contract calls
-- (e.g. aave-v3/supply), which reverted with invalid-argument errors.
--
-- The application no longer stores truncated values; this migration repairs
-- existing rows. For each web3 integration whose name matches the truncated
-- pattern, replace it with the canonical wallet address from
-- `para_wallets` (active wallet for the same organization).
--
-- Rows whose name does not match the truncation pattern are left alone --
-- those are user-supplied labels and must not be overwritten.

UPDATE "integrations" AS i
SET "name" = w."wallet_address"
FROM "para_wallets" AS w
WHERE i."type" = 'web3'
  AND i."organization_id" IS NOT NULL
  AND i."organization_id" = w."organization_id"
  AND w."is_active" = true
  AND i."name" ~ '^0x[a-fA-F0-9]+\.\.\.[a-fA-F0-9]+$';
