-- Arbitrum orders transactions first-come-first-served, so a priority fee buys nothing.
UPDATE "chains" SET "gas_config" = jsonb_set(COALESCE("gas_config", '{}'::jsonb), '{minPriorityFeeGwei}', '0'::jsonb) WHERE "chain_id" IN (42161, 421614);
