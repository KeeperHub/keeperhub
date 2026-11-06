SET lock_timeout = '3s';

ALTER TABLE "alert_settings" ALTER COLUMN "threshold" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "alert_settings" ADD COLUMN "paused_by_user_id" text;--> statement-breakpoint
ALTER TABLE "alert_overrides" ADD COLUMN "muted_at" timestamp;--> statement-breakpoint
-- Every mute ends within 7 days, including old "until it works" rows with no end.
UPDATE "alert_overrides" SET "muted_until" = LEAST(COALESCE("muted_until", "updated_at" + interval '7 days'), (now() AT TIME ZONE 'UTC') + interval '7 days') WHERE "muted_until" IS NOT NULL OR "mute_until_success";
