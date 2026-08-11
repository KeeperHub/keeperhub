-- ERC-8004 feedback table.
--
-- One row per submitted feedback. The id is used as the path segment of
-- the canonical feedbackURI (`/api/feedback/<id>`) referenced on-chain in
-- ReputationRegistry::giveFeedback. The off-chain JSON served at that URI
-- is reconstructed deterministically from this row + the referenced
-- workflow_executions row -- there is no denormalised JSON blob on the
-- table.
--
-- See lib/db/schema-feedback.ts for column rationale and lifecycle.

DO $$ BEGIN
  CREATE TYPE "feedback_status" AS ENUM ('pending', 'broadcast', 'confirmed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "feedback" (
  "id" text PRIMARY KEY NOT NULL,
  "execution_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "agent_registry" text NOT NULL DEFAULT 'erc-8004',
  "agent_chain_id" integer NOT NULL,
  "agent_id" text NOT NULL,
  "payer_wallet" text NOT NULL,
  "value" text NOT NULL,
  "value_decimals" integer NOT NULL,
  "comment" text,
  "feedback_hash" text,
  "tx_chain_id" integer NOT NULL,
  "tx_hash" text,
  "status" "feedback_status" NOT NULL DEFAULT 'pending',
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "broadcast_at" timestamp,
  "confirmed_at" timestamp
);

DO $$ BEGIN
  ALTER TABLE "feedback"
    ADD CONSTRAINT "feedback_execution_id_workflow_executions_id_fk"
    FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "feedback"
    ADD CONSTRAINT "feedback_workflow_id_workflows_id_fk"
    FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "idx_feedback_execution" ON "feedback" ("execution_id");
CREATE INDEX IF NOT EXISTS "idx_feedback_payer" ON "feedback" ("payer_wallet");
CREATE INDEX IF NOT EXISTS "idx_feedback_agent" ON "feedback" ("agent_registry", "agent_chain_id", "agent_id");
CREATE INDEX IF NOT EXISTS "idx_feedback_status" ON "feedback" ("status");
