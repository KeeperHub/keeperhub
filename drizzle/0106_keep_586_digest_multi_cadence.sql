-- Move the execution digest from a single cadence to a set of cadences, and
-- track last-sent per cadence so daily/weekly/monthly send independently.
-- Idempotent: safe to re-run.

ALTER TABLE workflow_execution_digest_settings
  ADD COLUMN IF NOT EXISTS cadences JSONB NOT NULL DEFAULT '["weekly"]'::jsonb;

ALTER TABLE workflow_execution_digest_settings
  ADD COLUMN IF NOT EXISTS last_sent JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill from the old single-choice columns when they still exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_execution_digest_settings'
      AND column_name = 'cadence'
  ) THEN
    UPDATE workflow_execution_digest_settings
    SET cadences = jsonb_build_array(cadence)
    WHERE cadences = '["weekly"]'::jsonb;

    UPDATE workflow_execution_digest_settings
    SET last_sent = jsonb_build_object(
      cadence,
      to_char(last_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    WHERE last_sent_at IS NOT NULL AND last_sent = '{}'::jsonb;
  END IF;
END $$;

ALTER TABLE workflow_execution_digest_settings DROP COLUMN IF EXISTS cadence;
ALTER TABLE workflow_execution_digest_settings DROP COLUMN IF EXISTS last_sent_at;
