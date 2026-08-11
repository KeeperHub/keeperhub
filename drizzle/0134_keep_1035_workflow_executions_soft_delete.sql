-- Soft-delete marker for workflow execution history. Purging a workflow's runs
-- sets deleted_at instead of hard-deleting the row, so billing usage counters
-- (which count all rows regardless of deleted_at) stay independent of history
-- purges. User-facing execution listings filter deleted_at IS NULL.
-- Nullable with no default, so this is a metadata-only ADD COLUMN: no table
-- rewrite and no long lock even on a large table (no @requires-db-prep needed).
-- Idempotent: safe to re-run.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP;
