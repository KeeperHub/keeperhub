ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signup_notified_at" timestamp;
--> statement-breakpoint
-- Rows older than the freshness window can never legitimately produce a signup
-- notification, so mark them as already notified. This keeps the column's
-- invariant true on its own rather than leaning on the freshness guard, and
-- stops a backlog of old accounts notifying if that guard is ever relaxed.
UPDATE "users"
SET "signup_notified_at" = "created_at"
WHERE "signup_notified_at" IS NULL
  AND "created_at" < now() - interval '24 hours';
