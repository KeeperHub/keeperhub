-- Records when an organization's one-time Stripe trial began. NULL means the
-- trial has not been consumed; a non-NULL value blocks a second trial.
-- Idempotent: safe to re-run on a DB that already has the column.
ALTER TABLE "organization_subscriptions" ADD COLUMN IF NOT EXISTS "trial_started_at" timestamp;
