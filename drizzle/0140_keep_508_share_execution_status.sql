-- Opt-in public execution status for public/unlisted workflows.
--
-- DEFAULT false: no retroactive exposure on deploy. Existing rows keep
-- share_execution_status = false until the owner explicitly enables sharing.
-- ADD COLUMN with a constant default is a metadata-only change on PG11+ but
-- still takes a brief ACCESS EXCLUSIVE lock that queues behind long reads.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "share_execution_status" boolean DEFAULT false NOT NULL;
