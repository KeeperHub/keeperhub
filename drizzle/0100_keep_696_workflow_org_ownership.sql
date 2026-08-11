-- KEEP-696: make the organization the authoritative owner of every workflow.
--
-- Backfills organization_id for legacy null-org workflows, then enforces
-- NOT NULL. workflows.user_id is retained as createdBy (audit only) and is NOT
-- touched here. Idempotent and safe to re-run: every step is a no-op once the
-- column is populated.
--
-- IMPORTANT (migration ordering): the Drizzle schema now declares
-- workflows.organization_id NOT NULL, so `drizzle-kit generate` will also want
-- to emit `ALTER COLUMN organization_id SET NOT NULL`. That generated form has
-- NO backfill and will fail on existing data. Keep THIS migration (it backfills
-- first) and drop the bare SET NOT NULL from any generated column migration for
-- workflows.organization_id. Runs inside the per-migration transaction, so a
-- failure rolls the whole thing back.

-- 1. Mint an org + owner membership for any user that owns a null-org workflow
--    but has no OWNER membership. This covers two legacy cases:
--    (a) users with no membership at all (fully anonymous, pre-org signup);
--    (b) users with only member/admin memberships but no owner role - step 2
--        assigns workflows to the oldest owned org, so a user with no owner
--        membership would produce NULL there and fail step 3.
DO $$
DECLARE
  r RECORD;
  v_org_id text;
BEGIN
  FOR r IN
    SELECT DISTINCT w.user_id AS user_id
    FROM workflows w
    WHERE w.organization_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM member m WHERE m.user_id = w.user_id AND m.role = 'owner')
  LOOP
    v_org_id := gen_random_uuid()::text;
    INSERT INTO organization (id, name, slug, created_at)
    SELECT
      v_org_id,
      COALESCE(u.name, 'User') || '''s Organization',
      'org-' || replace(gen_random_uuid()::text, '-', ''),
      now()
    FROM users u
    WHERE u.id = r.user_id;

    INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (gen_random_uuid()::text, v_org_id, r.user_id, 'owner', now());
  END LOOP;
END $$;

-- 2. Assign each null-org workflow to its createdBy user's earliest owned org.
--    Filter to role = 'owner' so workflows are not assigned to orgs the user
--    only has member/admin access to but does not control.
UPDATE workflows w
SET organization_id = (
  SELECT m.organization_id
  FROM member m
  WHERE m.user_id = w.user_id
    AND m.role = 'owner'
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1
)
WHERE w.organization_id IS NULL;

-- 3. Refuse to proceed if anything is still null (rolls back the transaction)
--    rather than letting the SET NOT NULL fail with a less actionable error.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM workflows WHERE organization_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'KEEP-696 backfill incomplete: % workflow(s) still have null organization_id', n;
  END IF;
END $$;

-- 4. Enforce the invariant.
ALTER TABLE workflows ALTER COLUMN organization_id SET NOT NULL;
