-- Per-integration authorization: gate credential use on the executing
-- principal's grant, not just shared org membership.
--
-- Until now any member of an integration's organization could run a workflow
-- referencing that integration and have its decrypted credentials used on
-- their behalf (validateWorkflowIntegrations only checked organization_id ==
-- workflow.organization_id). This migration introduces an explicit visibility
-- model so credential use can be scoped to the owner, named members, or the
-- whole org.
--
-- Backfill is deliberately non-breaking: existing org-scoped integrations are
-- set to 'organization' so currently-working workflows keep running. New
-- integrations default to 'private' (opt-in). Tightening an existing
-- integration to private/specific_members is a follow-up owner action.

CREATE TYPE "public"."integration_visibility" AS ENUM ('private', 'specific_members', 'organization');

ALTER TABLE "integrations"
  ADD COLUMN "visibility" "integration_visibility" NOT NULL DEFAULT 'private';

-- Preserve current behaviour for already-shared org credentials. Personal
-- (organization_id IS NULL) integrations stay 'private' (owner-only), which
-- matches the pre-migration owner-scoped check for anonymous workflows.
UPDATE "integrations"
   SET "visibility" = 'organization'
 WHERE "organization_id" IS NOT NULL;

CREATE TABLE "integration_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "integration_id" text NOT NULL,
  "user_id" text NOT NULL,
  "granted_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "integration_grants"
  ADD CONSTRAINT "integration_grants_integration_id_integrations_id_fk"
  FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "integration_grants"
  ADD CONSTRAINT "integration_grants_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "integration_grants"
  ADD CONSTRAINT "integration_grants_granted_by_users_id_fk"
  FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "idx_integration_grants_integration_user" ON "integration_grants" ("integration_id","user_id");
CREATE INDEX "idx_integration_grants_user" ON "integration_grants" ("user_id");
