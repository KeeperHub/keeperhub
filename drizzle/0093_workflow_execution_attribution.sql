-- KEEP-612 detection substrate: attribution columns on workflow_executions.
--
-- Adds five nullable columns so every new execution records who initiated it
-- and through which entry point:
--
--   triggered_by_user_api_key_id  FK -> api_keys (wfb_* webhook keys)
--   triggered_by_org_api_key_id   FK -> organization_api_keys (kh_* org keys)
--   triggered_by_ip               canonical client IP (cf-connecting-ip)
--   triggered_by_country          ISO-3166-1 alpha-2 from cf-ipcountry
--   trigger_source                manual | webhook | scheduled | mcp |
--                                 internal | block | event
--
-- All columns are NULL on legacy rows; the application populates them on
-- insert from now on. Behavioral detection alerts (KEEP-612) group by
-- (triggered_by_org_api_key_id, started_at) and (triggered_by_ip, ...) to
-- catch throughput spikes, off-hours use, and new-ASN access.
--
-- Both FKs are ON DELETE SET NULL: deleting a key (cascade from a
-- deactivated user, or explicit revoke) must not orphan or remove the
-- historical execution row.
--
-- Performance note: each ADD COLUMN with no default is metadata-only in
-- Postgres 11+ so this is safe on a hot table without rewrite.

ALTER TABLE "workflow_executions"
  ADD COLUMN "triggered_by_user_api_key_id" text,
  ADD COLUMN "triggered_by_org_api_key_id" text,
  ADD COLUMN "triggered_by_ip" text,
  ADD COLUMN "triggered_by_country" text,
  ADD COLUMN "trigger_source" text;

ALTER TABLE "workflow_executions"
  ADD CONSTRAINT "workflow_executions_triggered_by_user_api_key_id_fkey"
  FOREIGN KEY ("triggered_by_user_api_key_id")
  REFERENCES "api_keys"("id")
  ON DELETE SET NULL;

ALTER TABLE "workflow_executions"
  ADD CONSTRAINT "workflow_executions_triggered_by_org_api_key_id_fkey"
  FOREIGN KEY ("triggered_by_org_api_key_id")
  REFERENCES "organization_api_keys"("id")
  ON DELETE SET NULL;
