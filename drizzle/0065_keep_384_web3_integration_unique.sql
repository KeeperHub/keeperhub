-- KEEP-384 follow-up: enforce at most one cosmetic web3 integration per org.
--
-- Surfaced from PR #1070 review. ensureWalletIntegration in lib/db/integrations.ts
-- does a check-then-insert with no locking; two concurrent /api/integrations GETs
-- for the same org can both pass the existence check and both insert, producing
-- two web3 rows pointing at the same wallet. Visible in the workflow builder as
-- a duplicate radio entry plus loss of single-integration auto-select.
--
-- Step 1: dedupe any existing duplicates, keeping the oldest row per org so
-- user-supplied names / edits on the original survive. The (created_at, id)
-- tuple comparison gives a deterministic total order even when two rows tie
-- on microsecond-resolution created_at -- which is exactly what the race we
-- are closing produces. Without the id tiebreaker, ties survive on both
-- rows and the CREATE UNIQUE INDEX below would abort the migration.
DELETE FROM integrations a USING integrations b
WHERE a.organization_id = b.organization_id
  AND a.type = 'web3'
  AND b.type = 'web3'
  AND a.organization_id IS NOT NULL
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- Step 2: prevent the race from ever producing a duplicate again. Partial
-- index keyed on organization_id, scoped to web3 rows with a non-null org.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_integrations_org_web3"
  ON "integrations" ("organization_id")
  WHERE "type" = 'web3' AND "organization_id" IS NOT NULL;
