-- Rename the `is_user_error` boolean column on `workflow_executions` to a
-- text `error_type` column with values 'user' | 'system'. Aligns the column
-- name with the new Prometheus label vocabulary used across the counter,
-- gauge, structured logs, Sentry tags, and SLI alert.
--
-- Backfill uses a three-state CASE that preserves NULL for rows predating
-- classification:
--   is_user_error = TRUE   -> 'user'
--   is_user_error = FALSE  -> 'system'
--   is_user_error IS NULL  -> NULL (stays unclassified)
--
-- Mapping NULL to 'system' (as the original spec suggested) would pull
-- ~10.7k historical pre-classification errors into the platform SLI
-- denominator. Keeping NULL as NULL lets the SLI query exclude them via
-- `error_type IN ('user', 'system')` until a separate backfill decision is
-- made about that incident window.
ALTER TABLE "workflow_executions" ADD COLUMN "error_type" text;--> statement-breakpoint
UPDATE "workflow_executions"
  SET "error_type" = CASE
    WHEN "is_user_error" = TRUE  THEN 'user'
    WHEN "is_user_error" = FALSE THEN 'system'
  END
  WHERE "is_user_error" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "is_user_error";
