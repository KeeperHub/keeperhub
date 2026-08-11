-- KEEP-575: true-interval scheduling for "every N minutes" schedules.
--
-- The simple-mode "every N minutes" UI built `*/N * * * *`, which in 5-field
-- cron means "minutes divisible by N within each hour" — not a true every-N
-- interval. For N that doesn't divide 60 (50, 55, 17, 45, ...) the schedule
-- fires twice per hour with uneven gaps. A single 5-field cron expression
-- cannot express "every 55 minutes" because the period doesn't align with
-- hour boundaries.
--
-- These two columns let the dispatcher fire on `anchorAt + k * intervalSeconds`
-- when `interval_seconds` is set, falling back to `cron_expression` otherwise.
-- Both are nullable so existing cron-mode schedules stay on the cron path
-- untouched.
ALTER TABLE "workflow_schedules" ADD COLUMN "interval_seconds" integer;
--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD COLUMN "anchor_at" timestamp with time zone;
