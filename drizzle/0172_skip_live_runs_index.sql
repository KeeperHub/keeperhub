-- @requires-db-prep
-- Skip if running: findBlockingRun (lib/workflow/skip-if-running.ts) looks up a
-- workflow's live runs on every dispatch of a skip-flagged workflow. Partial on
-- the same literals the query uses, so a generic plan reads only live rows, not
-- the workflow's whole run history.
--
-- DB-PREP: workflow_executions is the largest table. On staging and prod an
-- operator applies `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` (same
-- definition) out-of-band before merge and checks no INVALID index is left,
-- so the plain statement below is a no-op there. On dev and PR-environment
-- databases it runs as written.
-- The plain statement still waits for ShareLock even when the index exists: bound the
-- wait, as 0173 does. Skip the SET lines in db-prep (they only act in a transaction).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_live_started" ON "workflow_executions" USING btree ("workflow_id","started_at" DESC NULLS LAST) WHERE "workflow_executions"."status" IN ('phantom', 'pending', 'running');--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
