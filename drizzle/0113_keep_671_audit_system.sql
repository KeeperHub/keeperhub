-- Durable forensic record of sensitive account/security actions: who did
-- what, when, from where, and -- for mutations -- a structured before/after
-- diff (deep-diff change records) in the `diff` jsonb column. Pairs with the
-- out-of-band email alerts: the email is the real-time signal, this table is
-- the queryable history.
--
-- actor_user_id and organization_id are ON DELETE SET NULL so purging a user
-- or org never erases the trail of what they did. action is plain text (not a
-- pgEnum) so adding a new audited action needs no follow-up migration.
--
-- Indexes trail with created_at: audit reads are always "filter by one
-- dimension, newest first", and Postgres serves ORDER BY created_at DESC from
-- an ascending composite via a backward scan, so filter + sort are one index
-- with no separate sort step.

CREATE TABLE "security_audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_user_id" text,
  "organization_id" text,
  "auth_method" text NOT NULL,
  "api_key_id" text,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "diff" jsonb,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "security_audit_log_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "security_audit_log_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "idx_security_audit_org_created" ON "security_audit_log" ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_actor_created" ON "security_audit_log" ("actor_user_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_resource_created" ON "security_audit_log" ("resource_type","resource_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_security_audit_action_created" ON "security_audit_log" ("action","created_at");
--> statement-breakpoint
-- Make the execution audit trail durable and reconstructable.
--
-- triggered_by_credential_type / triggered_by_credential_label: a durable
-- record of which credential triggered a run (webhook_key | org_api_key |
-- oauth | session | internal, plus a non-secret handle such as the key prefix
-- or internal caller name). The existing triggered_by_*_api_key_id FKs are
-- nulled when a key is revoked -- user webhook keys are hard-deleted -- which
-- erases "what did this credential run" exactly when an investigation needs
-- it. These columns survive revocation.
--
-- executed_workflow_hash: sha256 of the workflow definition (nodes + edges)
-- as it existed when the run was triggered. Ties a run to the exact definition
-- that produced it even after the workflow is later edited, and joins to
-- workflow_history.content_hash to resolve the full stored snapshot without
-- duplicating the graph on this high-volume table.

ALTER TABLE "workflow_executions"
  ADD COLUMN "triggered_by_credential_type" text;
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD COLUMN "triggered_by_credential_label" text;
--> statement-breakpoint
ALTER TABLE "workflow_executions"
  ADD COLUMN "executed_workflow_hash" text;
--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_executed_hash"
  ON "workflow_executions" ("executed_workflow_hash");
--> statement-breakpoint
-- One row per saved workflow version, powering the change-history timeline,
-- version load (?version=N), and restore. Complements security_audit_log:
-- that table keeps a lightweight cross-resource "who did what" event per
-- change; this holds the heavy per-version snapshot needed to diff and
-- restore. It mirrors the audit-log actor capture (changed_by_user_id,
-- auth_method, created_at) so "who did it" is answerable here too.
--
-- snapshot stores the full definition incl. edges (structural -- the executor
-- builds its run graph from them). change is the deep-diff vs the previous
-- version; both it and content_hash are computed over the meaningful
-- definition only (cosmetic ReactFlow state stripped in
-- lib/workflow/content-hash.ts). content_hash joins to
-- workflow_executions.executed_workflow_hash. version is a per-workflow
-- counter (unique with workflow_id).

CREATE TABLE "workflow_history" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "organization_id" text,
  "version" integer NOT NULL,
  "changed_by_user_id" text,
  "auth_method" text NOT NULL,
  "source" text NOT NULL,
  "snapshot" jsonb,
  "change" jsonb,
  "content_hash" text NOT NULL,
  "previous_version" integer,
  "previous_hash" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_history_workflow_id_workflows_id_fk"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade,
  CONSTRAINT "workflow_history_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE set null,
  CONSTRAINT "workflow_history_changed_by_user_id_users_id_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workflow_history_workflow_version" ON "workflow_history" ("workflow_id","version");
--> statement-breakpoint
CREATE INDEX "idx_workflow_history_content_hash" ON "workflow_history" ("content_hash");
--> statement-breakpoint
-- Extends security_audit_log so it can record deactivation/deletion cascades
-- as a general-purpose audit trail.
--
-- actor_label / organization_label: denormalized identity snapshots. The
-- actor_user_id and organization_id FKs are ON DELETE SET NULL, so a deletion
-- cascade (the very thing this audits) would otherwise erase its own
-- attribution when the user/org row is purged. These plain-text columns are
-- the durable fallback that survives the referenced row.
--
-- correlation_id: groups every row emitted by one logical operation, so a
-- cascade reads back as a single unit (filterable, served by the index below).
--
-- outcome: success rows are written inside the action's transaction; a
-- "failed" row is written out-of-band after a rollback, so a partial/failed
-- cascade still leaves a durable trace. Backfills existing rows to 'succeeded'.

ALTER TABLE "security_audit_log" ADD COLUMN "actor_label" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "organization_label" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "security_audit_log" ADD COLUMN "outcome" text DEFAULT 'succeeded' NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_security_audit_correlation_created" ON "security_audit_log" ("correlation_id","created_at");
--> statement-breakpoint
-- Make security_audit_log tamper-evident: rows are append-only.
--
-- A BEFORE trigger blocks every UPDATE, and blocks DELETE of any row still
-- inside the retention window. This stops an admin (or a compromised
-- application credential) from editing or deleting recent forensic records to
-- cover tracks, while still letting the retention job purge rows that have
-- aged out past the window. The window here MUST stay in sync with
-- AUDIT_RETENTION_DAYS in lib/security/audit-retention.ts.
CREATE OR REPLACE FUNCTION security_audit_log_append_only()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'security_audit_log is append-only: updates are not permitted';
  END IF;
  IF (TG_OP = 'DELETE') THEN
    IF (OLD.created_at > now() - interval '730 days') THEN
      RAISE EXCEPTION 'security_audit_log is append-only: rows within the retention window cannot be deleted';
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS security_audit_log_append_only ON "security_audit_log";
--> statement-breakpoint
CREATE TRIGGER security_audit_log_append_only
BEFORE UPDATE OR DELETE ON "security_audit_log"
FOR EACH ROW EXECUTE FUNCTION security_audit_log_append_only();
--> statement-breakpoint
-- Backfill "<type>.created" audit events for org resources that predate audit
-- logging, so the org activity feed shows a real (server-side, paginated)
-- creation baseline instead of a client-synthesized one. Each row is marked
-- metadata.backfilled = true for transparency, attributed to the resource's
-- creator (the read path resolves actor_user_id -> name/role), and stamped with
-- the resource's own created_at so it sorts as the oldest event for that
-- resource. NOT EXISTS keeps it idempotent: a resource that already has a real
-- ".created" event is skipped, so this never double-counts.
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, w.user_id, w.organization_id, 'internal', 'workflow.created', 'workflow', w.id, 'succeeded', '{"backfilled": true}'::jsonb, w.created_at
FROM "workflows" w
WHERE w.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'workflow' AND a.resource_id = w.id AND a.action = 'workflow.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, p.user_id, p.organization_id, 'internal', 'project.created', 'project', p.id, 'succeeded', '{"backfilled": true}'::jsonb, p.created_at
FROM "projects" p
WHERE p.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'project' AND a.resource_id = p.id AND a.action = 'project.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, t.user_id, t.organization_id, 'internal', 'tag.created', 'tag', t.id, 'succeeded', '{"backfilled": true}'::jsonb, t.created_at
FROM "tags" t
WHERE t.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'tag' AND a.resource_id = t.id AND a.action = 'tag.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, i.created_by, i.organization_id, 'internal', 'integration.created', 'integration', i.id, 'succeeded', '{"backfilled": true}'::jsonb, i.created_at
FROM "integrations" i
WHERE i.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'integration' AND a.resource_id = i.id AND a.action = 'integration.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, k.created_by, k.organization_id, 'internal', 'org_api_key.created', 'org_api_key', k.id, 'succeeded', '{"backfilled": true}'::jsonb, k.created_at
FROM "organization_api_keys" k
WHERE k.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'org_api_key' AND a.resource_id = k.id AND a.action = 'org_api_key.created'
  );
