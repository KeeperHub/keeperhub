-- Two-factor authentication storage and per-session MFA state.
--
-- two_factor: stores the user's TOTP secret and backup codes. Both columns
-- are encrypted at the application layer by Better Auth's twoFactor plugin
-- using BETTER_AUTH_SECRET (symmetric). DB-only compromise does not yield
-- recoverable codes; full DB + app-secret compromise does. Standard server-
-- TOTP threat model.
--
-- users.two_factor_enabled: surfaced into the session.user object so the
-- session.create.before hook can branch on enrollment without an extra
-- query. Flipped to true by the plugin's /two-factor/verify-totp endpoint
-- on first successful code entry.
--
-- sessions.requires_mfa: set to true when login risk detection (new
-- country / impossible travel) flags the sign-in AND the user has TOTP
-- enrolled. Application middleware refuses every request on a session
-- with requires_mfa=true except the verify-mfa endpoints. Cleared by the
-- step-up verify endpoint on success, which also stamps mfa_verified_at.
--
-- sessions.risk_flags_json: opaque JSON-encoded payload describing why a
-- session was flagged (country, prior-country sample, velocity). Read-only
-- diagnostic surface; not consumed by app logic. Kept short (target <1kb).

CREATE TABLE IF NOT EXISTS two_factor (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text,
  name text,
  enrolled_at timestamp NOT NULL DEFAULT now()
);

-- Idempotent guards for environments that already created the table
-- without these columns via an earlier draft of this migration.
ALTER TABLE two_factor
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE two_factor
  ADD COLUMN IF NOT EXISTS enrolled_at timestamp NOT NULL DEFAULT now();

ALTER TABLE two_factor
  ALTER COLUMN backup_codes DROP NOT NULL;

-- One enrollment row per user. Without this, concurrent /setup calls
-- (React StrictMode in dev fires the open-effect twice) interleave the
-- DELETE+INSERT and leave two rows behind; the plugin's verifyTotp
-- then findOne()s arbitrarily and the user's QR matches only one of
-- the two secrets, making verification a coin flip.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'two_factor_user_id_unique'
  ) THEN
    ALTER TABLE two_factor
      ADD CONSTRAINT two_factor_user_id_unique UNIQUE (user_id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_two_factor_user_id ON two_factor(user_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_enabled boolean DEFAULT false;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS requires_mfa boolean NOT NULL DEFAULT false;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamp;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS risk_flags_json text;
