-- Enforce one address book entry per (organization, address).
--
-- Required so wallet creation can call address book insert with
-- ON CONFLICT DO NOTHING and stay idempotent across:
--   - Turnkey EOA creation (one address per org)
--   - Safe deployment + reconcile-all (same CREATE2 address may be
--     adopted multiple times across chains for one org)
--   - Manual user-added entries that happen to match the wallet address
--
-- Storage convention (lib/address-utils.ts): addresses are stored lowercase.
-- The unique index therefore does not need lower(address), but existing
-- duplicates must be removed before the index is created.

DELETE FROM "address_book_entry" a
USING "address_book_entry" b
WHERE a."organization_id" = b."organization_id"
  AND a."address" = b."address"
  AND (
    a."created_at" > b."created_at"
    OR (a."created_at" = b."created_at" AND a."id" > b."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "idx_address_book_org_address"
  ON "address_book_entry" ("organization_id", "address");
