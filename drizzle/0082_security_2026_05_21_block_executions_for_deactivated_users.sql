-- Security incident 2026-05-21 follow-up: enforce containment at the DB layer.
--
-- Two app-layer bugs were exploited during the incident:
--
-- 1. Database Query plugin allowed arbitrary SQL against user-supplied
--    integrations. This was already blocked ad-hoc via the
--    block_database_integration_type() trigger applied directly to the prod
--    DB. Re-declare it here so the migration history is the source of truth.
--
-- 2. workflow_executions inserts did NOT check whether the owning user was
--    deactivated or the workflow was soft-deleted. As a result, accounts
--    flagged as compromised (users.deactivated_at IS NOT NULL) continued to
--    schedule and run workflows after deactivation, and soft-deleted
--    workflows (workflows.deleted_at IS NOT NULL) still received executions.
--    This trigger blocks the INSERT path at the DB.
--
-- Both triggers are intentionally permissive on UPDATE/DELETE of existing
-- rows so the security team can still soft-delete, mark errored, or backfill
-- history. INSERT is the only path that gates new attacker activity.

-- ---------------------------------------------------------------------------
-- 1. Block database-type integrations (already enforced in prod, declared here
--    so a fresh DB built from migrations gets the same protection).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_database_integration_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    MESSAGE = 'Database Query plugin disabled (security incident 2026-05-21). Contact security team.',
    ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS block_database_integrations_security_2026_05_21 ON integrations;

CREATE TRIGGER block_database_integrations_security_2026_05_21
  BEFORE INSERT OR UPDATE OF type, config ON integrations
  FOR EACH ROW
  WHEN (NEW.type = 'database')
  EXECUTE FUNCTION public.block_database_integration_type();

-- ---------------------------------------------------------------------------
-- 2. Block workflow_executions when owner is deactivated or workflow deleted.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_executions_for_inactive_workflows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_deactivated_at timestamp;
  v_workflow_deleted_at  timestamp;
BEGIN
  SELECT u.deactivated_at, w.deleted_at
    INTO v_owner_deactivated_at, v_workflow_deleted_at
  FROM workflows w
  LEFT JOIN users u ON u.id = w.user_id
  WHERE w.id = NEW.workflow_id;

  IF v_workflow_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Workflow is deleted; new executions are not allowed.',
      ERRCODE = '42501';
  END IF;

  IF v_owner_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Workflow owner is deactivated; new executions are not allowed.',
      ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_executions_security_2026_05_21 ON workflow_executions;

CREATE TRIGGER block_executions_security_2026_05_21
  BEFORE INSERT ON workflow_executions
  FOR EACH ROW
  EXECUTE FUNCTION public.block_executions_for_inactive_workflows();
