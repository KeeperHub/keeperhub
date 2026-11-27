-- Send as Bundle: the (chain, wallet, nonce) a bundle step's value reservation
-- was recorded at, so the daily value cap counts the reservation by that
-- pending_transactions row (pending or dropped: once per nonce; confirmed with
-- one of its run's hashes: counted; nonce used by another transaction: 0)
-- instead of by its age. Null for every other reservation.
--
-- Nullable, no default: metadata-only adds (no table rewrite). No index: the cap
-- query already narrows to the org's rows of today (idx_org_value_reservations_org_created),
-- and the lookup into pending_transactions uses its primary key.
-- LOCAL and reset at the end: drizzle-kit runs all pending files in one transaction,
-- so this timeout covers only this file's statements.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "org_value_reservations" ADD COLUMN IF NOT EXISTS "bundle_chain_id" integer;--> statement-breakpoint
ALTER TABLE "org_value_reservations" ADD COLUMN IF NOT EXISTS "bundle_wallet_address" text;--> statement-breakpoint
ALTER TABLE "org_value_reservations" ADD COLUMN IF NOT EXISTS "bundle_nonce" integer;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
