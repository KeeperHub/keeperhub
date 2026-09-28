-- @requires-db-prep
-- KEEP-1042: key idx_exec_logs_sponsored_execution on output, not output_raw.
--
-- The execution digest counts sponsored step runs off `output`. Retention nulls
-- `output_raw` after seven days and a monthly digest covers the whole month, so
-- a count off `output_raw` would report roughly the last week and print it as
-- the month. `sponsored` is not a redacted key, so both columns carry the same
-- value.
--
-- 0153 built this index keyed on `output_raw`. The planner uses a partial index
-- only when it can match the query clause to the index predicate, so once the
-- digest reads `output` it would ignore that index and go back to de-TOASTing
-- every log row in the window. This moves the predicate.
--
-- Same name, new predicate. `CREATE INDEX IF NOT EXISTS` compares the name only,
-- never the definition, so a plain drop-and-create cannot be prepared ahead:
-- the deploy would drop the prepared index and rebuild it under a lock. The
-- drop below fires only while the index still carries the `output_raw`
-- predicate, and the create then no-ops wherever the `output` form exists.
--
-- DB-PREP. Run each statement on its own, outside a transaction, after
-- SET statement_timeout = 0 in that session. The build reads the whole table,
-- so keep it away from the digest's 14:00 UTC send.
--
-- Where the index exists keyed on output_raw, swap it. Until the deploy lands,
-- the running digest still reads output_raw and has no index for it, so do
-- this close to the deploy:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_exec_logs_sponsored_execution;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exec_logs_sponsored_execution
--     ON workflow_execution_logs USING btree (execution_id)
--     WHERE output ->> 'sponsored' = 'true';
--
-- Where the index does not exist yet, run only the create, and run it before
-- the deploy that carries 0153. If the name is missing at deploy, 0153 builds
-- the output_raw form with a plain CREATE INDEX and this file then drops it and
-- builds the index a second time.
--
-- Confirm the predicate and validity before setting the db-prepped label:
--   SELECT indisvalid, pg_get_expr(indpred, indrelid) FROM pg_index
--   WHERE indexrelid = 'idx_exec_logs_sponsored_execution'::regclass;
--   -- expect: t | ((output ->> 'sponsored'::text) = 'true'::text)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('public.idx_exec_logs_sponsored_execution')
      AND pg_get_expr(indpred, indrelid) LIKE '%output_raw%'
  ) THEN
    DROP INDEX "idx_exec_logs_sponsored_execution";
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_exec_logs_sponsored_execution" ON "workflow_execution_logs" USING btree ("execution_id") WHERE "workflow_execution_logs"."output" ->> 'sponsored' = 'true';
