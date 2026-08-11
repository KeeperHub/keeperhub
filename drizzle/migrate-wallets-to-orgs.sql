-- Migration: Add organizationId to para_wallets
-- This truncates existing wallets since we're changing from user-owned to org-owned

-- Step 1: Truncate existing wallets (they were user-owned, we need org-owned)
TRUNCATE TABLE para_wallets;

-- Step 2: Remove old unique constraint on user_id if it exists
ALTER TABLE para_wallets DROP CONSTRAINT IF EXISTS para_wallets_user_id_unique;

-- Step 3: Add organization_id column (should already exist from schema)
ALTER TABLE para_wallets
ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL;

-- Step 4: Add foreign key constraint
ALTER TABLE para_wallets
ADD CONSTRAINT para_wallets_organization_id_organization_id_fk
FOREIGN KEY (organization_id)
REFERENCES organization(id)
ON DELETE CASCADE;

-- Step 5: Add unique constraint on organization_id (one wallet per org)
ALTER TABLE para_wallets
ADD CONSTRAINT para_wallets_organization_id_unique
UNIQUE (organization_id);
