-- Add the `verified` column Better Auth's two-factor plugin expects on the
-- two_factor table. Its verify-totp path updates this field to true when it is
-- not already strictly true; without the column the drizzle adapter strips the
-- update, producing an empty SET that Postgres rejects and breaking every
-- fresh TOTP sign-in.
--
-- NOT NULL DEFAULT true backfills existing enrolled rows to true in the same
-- statement, so the plugin reads verified = true and skips the write entirely.

ALTER TABLE "two_factor" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;
