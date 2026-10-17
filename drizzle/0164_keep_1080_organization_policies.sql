-- Organization policies: the engine's tables, the contract catalog it
-- reads, the limit ledger it reserves against, and the organization an
-- agentic wallet answers to.
--
-- One file on purpose. These arrived as five while the feature was being
-- built, which left four of them without a drizzle snapshot and made the
-- drift check propose recreating every table. A feature that lands once
-- should migrate once.

-- ---------------------------------------------------------------------
-- KEEP-1080: organization policy engine.
--
-- Three tables: the policy documents an organization authors, the resource
-- grants that decide what a subject can reach at all, and the decision log
-- that records every evaluation (and doubles as the receipt store linking the
-- node check to the signing-time check).

CREATE TABLE IF NOT EXISTS "organization_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"enforcement" text DEFAULT 'monitor' NOT NULL,
	"document" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_delay_hours" integer DEFAULT 0 NOT NULL,
	"effective_at" timestamp DEFAULT now() NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"resource" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"granted_by" text,
	"revoked_at" timestamp,
	"revoked_by" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"checkpoint" text NOT NULL,
	"capability" text NOT NULL,
	"resource" text,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"matched_sids" jsonb,
	"governing_policy_ids" jsonb,
	"facts" jsonb,
	"signals" jsonb,
	"observed_only" boolean DEFAULT false NOT NULL,
	"intent_digest" text,
	"receipt_status" text,
	"receipt_expires_at" timestamp,
	"policy_version" text,
	"principal_kind" text,
	"principal_id" text,
	"execution_id" text,
	"node_id" text,
	"workflow_id" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_policies_org_enabled" ON "organization_policies" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_org_policies_org_name" ON "organization_policies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_grants_subject" ON "resource_grants" USING btree ("organization_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_grants_org_revoked" ON "resource_grants" USING btree ("organization_id","revoked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_decisions_org_created" ON "policy_decisions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_decisions_outcome" ON "policy_decisions" USING btree ("organization_id","outcome","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_decisions_execution" ON "policy_decisions" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_decisions_digest" ON "policy_decisions" USING btree ("organization_id","intent_digest","receipt_status");

-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "contract_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"implementation_address" text,
	"protocol_slug" text,
	"abi" text,
	"abi_hash" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"catalog_version" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_catalog_chain_address_idx" ON "contract_catalog" USING btree ("chain_id","address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_catalog_protocol_idx" ON "contract_catalog" USING btree ("protocol_slug");

-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "policy_limit_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"sid" text NOT NULL,
	"metric" text NOT NULL,
	"window" text NOT NULL,
	"window_start" timestamp NOT NULL,
	"scope_key" text NOT NULL,
	"used" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "policy_limit_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_limit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"usage_id" text NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "policy_limit_reservations_usage_id_policy_limit_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "policy_limit_usage"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_limit_usage_window_idx" ON "policy_limit_usage" USING btree ("policy_id","sid","metric","window","window_start","scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_usage_org_idx" ON "policy_limit_usage" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_reservations_usage_idx" ON "policy_limit_reservations" USING btree ("usage_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_reservations_status_idx" ON "policy_limit_reservations" USING btree ("status","expires_at");

-- ---------------------------------------------------------------------
-- The organization answerable for what an agentic wallet signs. Policy is
-- org-scoped, so a wallet with no organization is one no rule can reach.
ALTER TABLE "agentic_wallets" ADD COLUMN IF NOT EXISTS "organization_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agentic_wallets_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "agentic_wallets"
      ADD CONSTRAINT "agentic_wallets_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agentic_wallets_organization"
  ON "agentic_wallets" ("organization_id");

-- Backfill only where the answer is unambiguous: the linked user belongs to
-- exactly one organization. A user in several is a choice for a person to make,
-- not one to infer, so those rows stay null and stay ungoverned until relinked.
UPDATE "agentic_wallets" w
SET "organization_id" = m."organization_id"
FROM (
  SELECT "user_id", MIN("organization_id") AS "organization_id"
  FROM "member"
  GROUP BY "user_id"
  HAVING COUNT(DISTINCT "organization_id") = 1
) m
WHERE w."linked_user_id" = m."user_id"
  AND w."organization_id" IS NULL;

