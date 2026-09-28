-- KEEP-1042: per-organization watermark for the step-log retention purge.
--
-- Every execution of an organization that started before
-- `executions_purged_through` has had its step logs removed. Without this the
-- purge cannot tell a drained organization from one it has never looked at, and
-- every run re-walks the whole already-purged history. That matters because the
-- plan windows differ by three orders of magnitude: a scan from the oldest row
-- walks millions of long-window rows to reach a handful of short-window ones.
--
-- Small and hot-path-free: one row per organization (about 1,400 on prod),
-- written once per organization per run and only when a range fully drains.
-- No @requires-db-prep directive: CREATE TABLE on a new relation takes no lock
-- on anything that exists.

CREATE TABLE "execution_retention_progress" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"executions_purged_through" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_retention_progress" ADD CONSTRAINT "execution_retention_progress_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
