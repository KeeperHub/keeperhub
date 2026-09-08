-- Per-user allowlist of trusted countries. Inserted when the user
-- signs in from a known country, or successfully verifies a new one
-- via /verify-ip. Matched against the CF-attested country at sign-in
-- and on every authenticated request. Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS user_trusted_countries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_trusted_countries_user_id
  ON user_trusted_countries (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trusted_countries_user_country
  ON user_trusted_countries (user_id, country);

-- Per-user device inventory keyed on the random id in the signed
-- kh_device_id cookie. A device not in this list signing in from a
-- trusted country is allowed through but triggers a warning email.
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS user_trusted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  user_agent TEXT,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_trusted_devices_user_id
  ON user_trusted_devices (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trusted_devices_user_device
  ON user_trusted_devices (user_id, device_id);
