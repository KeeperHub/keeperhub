-- KEEP-696: rename integrations.user_id to created_by.
--
-- workflows.userId was demoted to audit-only (createdBy) by the org-ownership
-- migration; integrations.user_id carries the same semantic -- the creator of
-- the credential row, not its owner -- and must match for consistency.
-- PostgreSQL automatically updates the FK constraint reference on column rename;
-- the per-column index is recreated under the new name.
--
-- Hand-authored: drizzle-kit generate is broken by the pre-existing
-- snapshot-parent collision (0082-0085/0089 all point at 0081).

ALTER TABLE integrations RENAME COLUMN user_id TO created_by;

DROP INDEX IF EXISTS idx_integrations_user_id;
CREATE INDEX idx_integrations_created_by ON integrations (created_by);
