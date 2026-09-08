-- Calldata-only marketplace sales.
--
-- A paid write listing returns unsigned calldata and runs no executor, so
-- there is no workflow_executions row to point at. execution_id becomes
-- nullable, `kind` distinguishes the two sale types, and `deliverable` stores
-- the artifact that was sold so a replayed payment credential can be answered
-- with exactly the bytes it already bought (the payment hash covers the
-- credential alone and is not bound to the request body, so regenerating on
-- replay would let one signature buy calldata for any recipient).
--
-- No lock-free prep needed: DROP NOT NULL is a catalog-only change, and
-- ADD COLUMN with a constant DEFAULT (or with no default) is metadata-only on
-- PG11+. Each takes only a momentary ACCESS EXCLUSIVE lock, no table rewrite,
-- no scan -- so the @requires-db-prep directive does not apply.
--
-- No backfill: every existing row has a non-null execution_id (the NOT NULL
-- guaranteed it) and the constant DEFAULT stamps kind='execution' on them as
-- metadata.
ALTER TABLE "workflow_payments" ALTER COLUMN "execution_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_payments" ADD COLUMN "kind" varchar(16) DEFAULT 'execution' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_payments" ADD COLUMN "deliverable" jsonb;
