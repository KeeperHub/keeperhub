-- KEEP-693: surface system/infra failures on workflow runs as stable error
-- codes.
--
-- Adds a nullable `error_code` column holding a `PREFIX-NNNN` system error code
-- (see lib/errors/error-codes.ts). Populated alongside the existing
-- error_category / error_type columns at terminal finalize, by the reaper, and
-- at the executor/scheduler dispatch sites. Null on user-config failures (which
-- surface their raw message) and on legacy rows -- no backfill.
--
-- The new `phantom` status (an expected-but-not-yet-started trigger that the
-- scheduler/event-tracker pre-creates and the executor upgrades to `pending`)
-- needs no DDL: `status` is a plain text column, not a pgEnum, so widening the
-- application-level union is sufficient.

ALTER TABLE "workflow_executions" ADD COLUMN "error_code" text;
