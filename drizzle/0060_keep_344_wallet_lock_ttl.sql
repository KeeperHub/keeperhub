-- KEEP-344: replace advisory-lock metadata table with row-based TTL lock.
-- Adds expires_at so the row itself is the lock; a crashed holder no longer
-- wedges the wallet+chain forever.
ALTER TABLE "wallet_locks" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() NOT NULL;
