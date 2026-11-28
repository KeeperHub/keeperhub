-- @requires-db-prep
-- Skip if running: findSkippedKey (lib/workflow/skip-if-running.ts) looks up a
-- workflow's Skipped rows from the last two minutes on every dispatch made
-- while a run is live. Partial on the same literals the query uses, so only
-- skipped-behind rows are indexed.
--
-- DB-PREP: workflow_executions is the largest table. On staging and prod an
-- operator applies `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (same
-- definition) out-of-band before merge and checks no INVALID index is left,
-- so the plain statement below is a no-op there. On dev and PR-environment
-- databases it runs as written.
-- The plain statement still waits for ShareLock even when the index exists: bound the
-- wait, as 0174 does. Skip the SET lines in db-prep (they only act in a transaction).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_skipped_behind" ON "workflow_executions" USING btree ("workflow_id","completed_at") WHERE "workflow_executions"."status" = 'skipped' AND "workflow_executions"."dispatch_key" LIKE 'skipped-behind:%';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
