-- KEEP-177 review #3 HIGH: safe_role_direct_rules.token_address unique-index
-- bug. Postgres' default NULLs-are-distinct semantics meant two native-transfer
-- rules with the same (role, kind, counterparty) inserted duplicate rows
-- instead of upserting. Switch to NATIVE_TOKEN_SENTINEL (zero address) for
-- native rules and tighten the column to NOT NULL. Mirrors what
-- safe_role_allowances.token_address already does.

-- Dedupe any pre-existing NULL-tokenAddress rows that share the same
-- (role_id, kind, counterparty) tuple. Keep the most recent by
-- last_updated_at; drop older duplicates. Runs first so the UPDATE below
-- does not violate the unique index.
DELETE FROM "safe_role_direct_rules" a
USING "safe_role_direct_rules" b
WHERE a."token_address" IS NULL
  AND b."token_address" IS NULL
  AND a."role_id" = b."role_id"
  AND a."kind" = b."kind"
  AND a."counterparty" = b."counterparty"
  AND a."last_updated_at" < b."last_updated_at";
--> statement-breakpoint

-- Backfill the sentinel for the surviving native-transfer rows.
UPDATE "safe_role_direct_rules"
SET "token_address" = '0x0000000000000000000000000000000000000000'
WHERE "token_address" IS NULL;
--> statement-breakpoint

ALTER TABLE "safe_role_direct_rules" ALTER COLUMN "token_address" SET NOT NULL;
