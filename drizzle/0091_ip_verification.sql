-- Per-user allowlist of trusted IPs. Inserted when the user
-- successfully verifies a new IP via /verify-ip; matched against
-- the request IP at every fresh session creation.
CREATE TABLE IF NOT EXISTS user_trusted_ips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  country TEXT,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_trusted_ips_user_id
  ON user_trusted_ips (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trusted_ips_user_ip
  ON user_trusted_ips (user_id, ip);
