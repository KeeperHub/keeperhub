-- KEEP-230: Decommission Para wallet provider.
--
-- Drops Para-specific columns from the wallets table now that all production
-- signing is performed via Turnkey. Inactive Para rows are removed first so
-- the surviving rows are guaranteed to have Turnkey credentials. The table is
-- renamed from `para_wallets` to `organization_wallets` to match its purpose.

DELETE FROM para_wallets WHERE provider IS DISTINCT FROM 'turnkey';

ALTER TABLE para_wallets DROP COLUMN IF EXISTS provider;
ALTER TABLE para_wallets DROP COLUMN IF EXISTS para_wallet_id;
ALTER TABLE para_wallets DROP COLUMN IF EXISTS user_share;

ALTER TABLE para_wallets RENAME TO organization_wallets;

ALTER TABLE organization_wallets RENAME CONSTRAINT "para_wallets_user_id_users_id_fk" TO "organization_wallets_user_id_users_id_fk";
ALTER TABLE organization_wallets RENAME CONSTRAINT "para_wallets_organization_id_organization_id_fk" TO "organization_wallets_organization_id_organization_id_fk";

-- safe_wallets.owner_wallet_id FK was created by 0079 with the legacy
-- para_wallets table name embedded; rename so future drizzle introspection
-- diffs stay quiet (the FK target was auto-updated by the table RENAME).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'safe_wallets_owner_wallet_id_para_wallets_id_fk'
  ) THEN
    ALTER TABLE safe_wallets RENAME CONSTRAINT "safe_wallets_owner_wallet_id_para_wallets_id_fk" TO "safe_wallets_owner_wallet_id_organization_wallets_id_fk";
  END IF;
END $$;

ALTER INDEX IF EXISTS "para_wallets_org_active_unique" RENAME TO "organization_wallets_org_active_unique";
