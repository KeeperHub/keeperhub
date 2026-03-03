-- Fix duration values that were stored with decimal precision
-- by a manual UPDATE that used EXTRACT(EPOCH ...) * 1000.
-- The duration column is text storing integer milliseconds,
-- but some rows now contain decimal strings like "1234567.890"
-- which break CAST(duration AS INTEGER) in analytics queries.

UPDATE "workflow_executions"
SET "duration" = ROUND(CAST("duration" AS NUMERIC))::TEXT
WHERE "status" = 'cancelled'
  AND "duration" IS NOT NULL
  AND "duration" ~ '\.';
