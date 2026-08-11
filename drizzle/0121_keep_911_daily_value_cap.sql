-- KEEP-911: cap the notional VALUE moved (not gas) per org per day.
--
-- direct_executions.value_wei holds the native value (wei) reserved for each
-- execution at request time; spending-cap enforcement sums it per org per day.
-- organization_spend_caps.daily_value_cap_wei is the enforced limit (native
-- value); the pre-existing daily_cap_wei stays as a legacy gas-denominated
-- figure for the analytics gauge. Both new columns are nullable (a null
-- value_wei counts as 0; a null daily_value_cap_wei means no value cap).
--
-- No lock-free prep needed: ADD COLUMN of a nullable column with no default is
-- a catalog-only change in PostgreSQL 11+ (momentary ACCESS EXCLUSIVE lock, no
-- table rewrite), safe inline via the normal migrate path.

ALTER TABLE "direct_executions" ADD COLUMN IF NOT EXISTS "value_wei" text;--> statement-breakpoint
ALTER TABLE "organization_spend_caps" ADD COLUMN IF NOT EXISTS "daily_value_cap_wei" text;--> statement-breakpoint
-- daily_cap_wei is legacy (gas-denominated, no longer enforced); make it
-- nullable so an admin-set value-only cap row can be created without it.
ALTER TABLE "organization_spend_caps" ALTER COLUMN "daily_cap_wei" DROP NOT NULL;
