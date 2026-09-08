-- KEEP-1240: Add gas_config column to chains table for chain-specific gas settings
-- This allows per-chain configuration of gas limits, priority fees, and other gas-related parameters

ALTER TABLE "chains" ADD COLUMN "gas_config" jsonb DEFAULT '{}';

-- Add comment explaining the structure
COMMENT ON COLUMN "chains"."gas_config" IS 'Chain-specific gas configuration. JSON schema: { gasLimitMultiplier?: number, gasLimitMultiplierConservative?: number, minPriorityFeeGwei?: number, maxPriorityFeeGwei?: number, volatilityThreshold?: number, maxFeeMultiplier?: number }';

-- Seed default configurations for known chains
UPDATE "chains" SET "gas_config" = '{
  "gasLimitMultiplier": 2.0,
  "gasLimitMultiplierConservative": 2.5,
  "minPriorityFeeGwei": 0.5
}' WHERE "chain_id" = 1;

UPDATE "chains" SET "gas_config" = '{
  "gasLimitMultiplier": 2.0,
  "gasLimitMultiplierConservative": 2.5,
  "minPriorityFeeGwei": 0.1
}' WHERE "chain_id" = 11155111;

UPDATE "chains" SET "gas_config" = '{
  "gasLimitMultiplier": 1.5,
  "gasLimitMultiplierConservative": 2.0,
  "minPriorityFeeGwei": 0.01,
  "maxPriorityFeeGwei": 10
}' WHERE "chain_id" IN (42161, 421614);

UPDATE "chains" SET "gas_config" = '{
  "gasLimitMultiplier": 1.5,
  "gasLimitMultiplierConservative": 2.0,
  "minPriorityFeeGwei": 0.001,
  "maxPriorityFeeGwei": 5
}' WHERE "chain_id" IN (8453, 84532);

UPDATE "chains" SET "gas_config" = '{
  "gasLimitMultiplier": 2.0,
  "gasLimitMultiplierConservative": 2.5,
  "minPriorityFeeGwei": 30,
  "maxPriorityFeeGwei": 1000
}' WHERE "chain_id" IN (137, 80002);
