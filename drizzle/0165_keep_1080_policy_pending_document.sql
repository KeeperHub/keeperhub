-- A delayed policy edit now waits beside the one in force instead of
-- replacing it early.
--
-- Setting a change delay used to push effective_at into the future, and the
-- store only loads policies whose effective_at has passed, so the policy
-- stopped being enforced for the length of the delay. A delay is meant to make
-- a weakening visible before it takes hold, which requires the old rules to
-- keep applying until then; as written it removed them immediately instead.
ALTER TABLE "organization_policies"
  ADD COLUMN IF NOT EXISTS "pending_document" jsonb;
ALTER TABLE "organization_policies"
  ADD COLUMN IF NOT EXISTS "pending_effective_at" timestamp;
