-- @requires-db-prep
-- KEEP-432: post-incident additive index migration.
--
-- The `-- @requires-db-prep` directive on line 1 makes the
-- `.github/workflows/db-prep-check.yml` workflow block merge of this PR
-- (and any future PR including this file) until the matching
-- `db-prepped-<target-branch>` label is set. The label signals that an
-- operator has applied each index via `CREATE INDEX CONCURRENTLY IF NOT
-- EXISTS` against the real DB out-of-band, BEFORE the deploy runs the
-- normal `drizzle-kit migrate`.
--
-- Why: drizzle-kit wraps every migration in a transaction, and
-- `CREATE INDEX CONCURRENTLY` cannot run in a transaction. Without the
-- pre-applied CONCURRENTLY indexes, the plain CREATE INDEX statements
-- below would take an ACCESS EXCLUSIVE lock on workflow_execution_logs
-- (1.9 GB on prod) for the duration of the build - the multi-minute lock
-- this PR exists to avoid. With CONCURRENTLY pre-applied, the IF NOT
-- EXISTS clauses make each statement here a no-op on real envs. On dev /
-- PR-environment DBs the tables are small or empty so the plain CREATE
-- INDEX runs without user-visible impact.
--
-- Operator runbook (per target environment):
--   1. Connect to the target DB via psql or kubectl exec.
--   2. Run each statement below with `CREATE INDEX CONCURRENTLY IF NOT
--      EXISTS` instead of `CREATE INDEX IF NOT EXISTS`. CONCURRENTLY
--      statements must be run one-at-a-time, NOT inside a transaction
--      block.
--   3. Verify no INVALID indexes were left behind:
--      `SELECT relname FROM pg_index JOIN pg_class ON pg_class.oid =
--      indexrelid WHERE NOT indisvalid;`
--   4. Add the `db-prepped-<branch>` label to the PR.
--
-- Background: the 2026-05-05 RDS CPU incident traced to a per-org
-- gas-usage aggregate over workflow_execution_logs which seq-scanned a
-- 1.9 GB table. That query path now has direct index support via
-- idx_exec_logs_started_at. The rest of this migration adds the missing
-- FK indexes Postgres does not auto-create.

CREATE INDEX IF NOT EXISTS "idx_exec_logs_started_at"
  ON "workflow_execution_logs" ("started_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_workflow_executions_user_id"
  ON "workflow_executions" ("user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_workflows_tag_id"
  ON "workflows" ("tag_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_workflows_project_id"
  ON "workflows" ("project_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_workflows_user_id"
  ON "workflows" ("user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_accounts_user_id"
  ON "accounts" ("user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sessions_user_id"
  ON "sessions" ("user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_member_user_id"
  ON "member" ("user_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_member_organization_id"
  ON "member" ("organization_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_api_keys_org_id"
  ON "organization_api_keys" ("organization_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_org_api_keys_created_by"
  ON "organization_api_keys" ("created_by");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_integrations_user_id"
  ON "integrations" ("user_id");
