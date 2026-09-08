-- KEEP-696: deactivation state columns.
--
-- workflows.deactivated_at: a deactivated workflow is fully off - it cannot be
-- enabled or triggered manually (distinct from `enabled`, which gates automated
-- dispatch only, and from `deleted_at`, the slug-hiding soft delete).
-- organization.deactivated_at: a deactivated org denies member access and
-- blocks execution of its workflows; set by the owner-deactivation cascade.
--
-- Hand-authored: `drizzle-kit generate` currently fails on a pre-existing
-- snapshot-parent collision (0082-0085/0089 all point at 0081), so the column
-- DDL is written directly, following the 0082/0085/0090 convention.

ALTER TABLE workflows    ADD COLUMN IF NOT EXISTS deactivated_at timestamp;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS deactivated_at timestamp;
