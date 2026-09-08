-- Better Auth's two-factor plugin owns an account-lockout feature that is
-- enabled by default (resolveAccountLockoutConfig reads
-- `enabled: lockout?.enabled ?? true`, and lib/auth.ts passes no accountLockout
-- option). It reads and writes exactly two fields on this table:
-- failedVerificationCount and lockedUntil.
--
-- Neither column existed, so resetTwoFactorFailures - which runs on every
-- SUCCESSFUL verification - had both fields stripped by the drizzle adapter and
-- emitted `UPDATE two_factor SET  WHERE ...`, which Postgres rejects. A correct
-- TOTP code therefore 500'd after validating. The same gap made the lockout
-- inert: assertTwoFactorNotLocked gates on locked_until, which read as
-- undefined, so the cap on consecutive failed verifications never applied.
--
-- two_factor holds one row per enrolled user and is small; adding a column with
-- a constant default is metadata-only on PG11+, so no table rewrite and no long
-- lock (no @requires-db-prep needed).
-- Idempotent: safe to re-run.
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "failed_verification_count" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP;
