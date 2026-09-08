-- KEEP-696: deactivation cascades for orgs and workflows.
--
-- Builds on the user-deactivation hardening (0082/0085/0090). Two changes:
--
-- 1. Extend block_executions_for_inactive_workflows() so a new
--    workflow_executions row is also rejected when the workflow itself is
--    deactivated (workflows.deactivated_at) or its owning org is deactivated
--    (organization.deactivated_at), in addition to the existing soft-delete
--    and owner-deactivation checks. CREATE OR REPLACE updates the function in
--    place; the trigger created in 0082 (block_executions_security_2026_05_21)
--    already binds to it, so it does not need to be recreated.
--
-- 2. Add cascade_org_deactivation_on_owner(): when a user is deactivated
--    (deactivated_at NULL -> non-NULL), deactivate every org that user owns
--    BUT only when no other active owner remains, so a co-owned org is not
--    taken down because one of its owners left. Fires only on the NULL ->
--    non-NULL transition, so reactivating a user is a no-op cascade-wise
--    (org reactivation is a manual/ops action), mirroring 0085.
--
-- This migration depends on the workflows.deactivated_at and
-- organization.deactivated_at columns added by the preceding column migration.

-- ---------------------------------------------------------------------------
-- 1. Extend the execution block with workflow- and org-level deactivation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_executions_for_inactive_workflows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_workflow_deleted_at     timestamp;
  v_workflow_deactivated_at timestamp;
  v_org_deactivated_at      timestamp;
BEGIN
  -- Ownership lives on the organization, not the creating user. The owner
  -- gate is therefore the org's deactivated_at (deactivating an org owner
  -- cascades to it), NOT workflows.user_id, which is createdBy/audit only.
  SELECT w.deleted_at,
         w.deactivated_at,
         o.deactivated_at
    INTO v_workflow_deleted_at,
         v_workflow_deactivated_at,
         v_org_deactivated_at
  FROM workflows w
  LEFT JOIN organization o ON o.id = w.organization_id
  WHERE w.id = NEW.workflow_id;

  IF v_workflow_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Workflow is deleted; new executions are not allowed.',
      ERRCODE = '42501';
  END IF;

  IF v_workflow_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Workflow is deactivated; new executions are not allowed.',
      ERRCODE = '42501';
  END IF;

  IF v_org_deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Workflow organization is deactivated; new executions are not allowed.',
      ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Cascade org deactivation when an owner is deactivated and no active
--    owner remains.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cascade_org_deactivation_on_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE organization o
     SET deactivated_at = NEW.deactivated_at
   WHERE o.deactivated_at IS NULL
     -- the just-deactivated user owns this org
     AND EXISTS (
       SELECT 1
         FROM member m
        WHERE m.organization_id = o.id
          AND m.user_id = NEW.id
          AND m.role = 'owner'
     )
     -- and no other owner is still active. NEW.deactivated_at is already
     -- persisted on this user's row at AFTER UPDATE time, so the deactivated
     -- owner is correctly excluded from the "active owner" set below.
     AND NOT EXISTS (
       SELECT 1
         FROM member m2
         JOIN users u2 ON u2.id = m2.user_id
        WHERE m2.organization_id = o.id
          AND m2.role = 'owner'
          AND u2.deactivated_at IS NULL
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cascade_org_deactivation_on_owner ON users;

CREATE TRIGGER cascade_org_deactivation_on_owner
  AFTER UPDATE OF deactivated_at ON users
  FOR EACH ROW
  WHEN (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL)
  EXECUTE FUNCTION public.cascade_org_deactivation_on_owner();
