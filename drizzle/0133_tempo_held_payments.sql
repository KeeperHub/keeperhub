-- Tempo held payments: a payment signed now as a native Tempo scheduled
-- transaction (valid_before is the on-chain safety expiry) whose broadcast
-- KeeperHub owns. serialized_tx is the self-contained 0x76 blob; broadcasting
-- it needs no further signing. A null broadcast_at is a manual hold; a set
-- broadcast_at is the target time a scheduled poller fires it.
-- New empty table, so a plain CREATE is safe (no @requires-db-prep needed).
-- Idempotent: safe to re-run on a DB that already has the type / table.
DO $$ BEGIN
  CREATE TYPE "public"."tempo_held_payment_status" AS ENUM (
    'pending', 'broadcasting', 'broadcast', 'confirmed', 'failed', 'expired', 'canceled'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "tempo_held_payments" (
  "id" TEXT PRIMARY KEY,
  "organization_id" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_by_user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "workflow_id" TEXT,
  "execution_id" TEXT,
  "chain_id" INTEGER NOT NULL,
  "from_address" TEXT NOT NULL,
  "to_address" TEXT NOT NULL,
  "token_address" TEXT NOT NULL,
  "amount_raw" TEXT NOT NULL,
  "token_symbol" TEXT,
  "token_decimals" INTEGER,
  "amount_display" TEXT,
  "memo" TEXT,
  "serialized_tx" TEXT NOT NULL,
  "precomputed_hash" TEXT NOT NULL,
  "nonce_key" TEXT NOT NULL,
  "max_fee_per_gas" TEXT,
  "valid_after" BIGINT,
  "valid_before" BIGINT NOT NULL,
  "broadcast_at" TIMESTAMP,
  "status" "public"."tempo_held_payment_status" NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "broadcast_tx_hash" TEXT,
  "dispatch_key" TEXT,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_tempo_held_payments_org"
  ON "tempo_held_payments" ("organization_id");
-- Org-scoped list ordered by created_at (the paginated UI query).
CREATE INDEX IF NOT EXISTS "idx_tempo_held_payments_org_created"
  ON "tempo_held_payments" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_tempo_held_payments_status"
  ON "tempo_held_payments" ("status");
-- Due poller: pending rows whose broadcast_at has arrived.
CREATE INDEX IF NOT EXISTS "idx_tempo_held_payments_due"
  ON "tempo_held_payments" ("status", "broadcast_at");
-- Expiry sweep: pending rows whose valid_before has lapsed.
CREATE INDEX IF NOT EXISTS "idx_tempo_held_payments_expiry"
  ON "tempo_held_payments" ("status", "valid_before");
-- One row per signed blob: re-inserting the same signed tx is blocked.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tempo_held_payments_hash"
  ON "tempo_held_payments" ("precomputed_hash");
-- Belt-and-suspenders idempotency for the scheduled poller.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tempo_held_payments_dispatch_key"
  ON "tempo_held_payments" ("dispatch_key");
