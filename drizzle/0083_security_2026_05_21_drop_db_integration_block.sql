-- Security incident 2026-05-21 follow-up: drop the global Database Query plugin block.
--
-- During the active incident we installed the block_database_integration_type
-- trigger on integrations (migration 0082) to refuse every INSERT / UPDATE that
-- set type='database', neutralising the DB Query plugin entirely while the
-- attacker still had ways in.
--
-- The other defences from that window are still in place and now sufficient:
--   - block_executions trigger on workflow_executions (deactivated owner /
--     deleted workflow inserts rejected at the DB layer)
--   - SSRF guard parity across HTTP and database plugin SQL paths
--   - NetworkPolicy on workflow-runner pods (egress block to 169.254.0.0/16,
--     link-local, ULA)
--   - IMDSv2 hop-limit=1 on all Karpenter NodeClasses
--   - Compromised user accounts hard-deleted, remaining attacker channels
--     (sessions, OAuth links, api_keys, org_api_keys, integrations) wiped
--
-- Legitimate operators (e.g. Sky engineers monitoring chief-keeper-spells,
-- Neon-hosted analytics DBs) need the DB Query plugin back to re-create
-- their integrations after the incident-wide credential rotation. This
-- migration drops the global block; the kill switch on workflow_executions
-- keeps any future deactivated account from running anything regardless of
-- plugin type.
--
-- The trigger + function were already dropped on the prod DB during incident
-- response; the migration uses IF EXISTS so it is a no-op when re-applied
-- there but still removes the trigger from any fresh DB built from
-- migrations.

DROP TRIGGER IF EXISTS block_database_integrations_security_2026_05_21 ON integrations;

DROP FUNCTION IF EXISTS public.block_database_integration_type();
