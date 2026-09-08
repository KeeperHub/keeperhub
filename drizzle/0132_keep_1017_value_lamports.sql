-- Lamports-denominated value columns for the two daily-cap ledger stores.
--
-- Kept separate from the existing value_wei columns rather than reusing them:
-- the daily cap sums these per org, and wei (1e18) and lamports (1e9) are
-- different units, so a shared column would silently add the two scales
-- together and understate cap usage.
--
-- Exactly one of value_wei / value_lamports carries the real figure per row.
-- org_value_reservations.value_wei is NOT NULL and predates this, so Solana
-- rows there carry "0" in value_wei; the wei SUM is therefore unaffected by
-- Solana activity, and the lamports SUM is unaffected by EVM activity.
--
-- Both columns are nullable with no default, so these are metadata-only adds
-- (no table rewrite).
ALTER TABLE "direct_executions" ADD COLUMN IF NOT EXISTS "value_lamports" text;
ALTER TABLE "org_value_reservations" ADD COLUMN IF NOT EXISTS "value_lamports" text;
