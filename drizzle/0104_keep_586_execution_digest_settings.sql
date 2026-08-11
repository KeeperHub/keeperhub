-- Per-org scheduled execution-digest settings (paid-only email digest).
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS workflow_execution_digest_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cadence TEXT NOT NULL DEFAULT 'weekly',
  subscriber_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_digest_enabled
  ON workflow_execution_digest_settings (enabled);
