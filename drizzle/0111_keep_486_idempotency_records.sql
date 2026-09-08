-- Idempotency-Key support for mutating API endpoints. The first request for a
-- given (organization, scope, key) reserves a row (status "processing"); the
-- response is stored once the work finishes (status "completed") and replayed
-- for any retry within the TTL, so a network retry never double-executes.
-- `scope` namespaces the operation so a key is independent across unrelated
-- operations but unique within one. Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS idempotency_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  lock_version INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  response_body JSONB,
  resource_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_org_scope_key
  ON idempotency_records (organization_id, scope, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
  ON idempotency_records (expires_at);
