-- KEEP-696: enforce single owner per organization.
--
-- Orgs can only have one owner. This partial unique index makes that a hard
-- database constraint rather than a convention enforced only by application
-- logic. A partial index (WHERE role = 'owner') avoids interfering with the
-- unlimited members/admins per org.
--
-- The leave route's ownership-transfer path (promote new owner, delete
-- outgoing owner) must delete the outgoing owner BEFORE promoting the
-- incoming owner so this IMMEDIATE constraint is never transiently violated
-- within the transaction.

CREATE UNIQUE INDEX member_org_single_owner ON member(organization_id) WHERE role = 'owner';
