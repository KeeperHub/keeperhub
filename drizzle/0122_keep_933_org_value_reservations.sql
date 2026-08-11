-- KEEP-933: close the workflow/protocol value-cap bypass.
--
-- The KEEP-911 daily value cap is only charged by the direct-execution API
-- routes (direct_executions.value_wei). Value moved by a workflow run or a
-- protocol write goes through the same value-moving cores but never touches
-- direct_executions, so an authenticated key could create+trigger a workflow to
-- exceed the cap. This ledger records reservations from those other entrances;
-- the cap SUM now unions both stores, so every value-moving path is bounded by
-- the same per-org daily cap.
--
-- status: reserved (in-flight) | settled (broadcast succeeded, counts all day) |
-- released (denied/failed, drops out of the SUM). Native value only, in wei.
--
-- Plain CREATE TABLE + CREATE INDEX on a brand-new (empty) table takes no
-- meaningful lock, so no lock-free prep is required.

CREATE TABLE IF NOT EXISTS "org_value_reservations" (
    "id" text PRIMARY KEY NOT NULL,
    "organization_id" text NOT NULL,
    "value_wei" text NOT NULL,
    "status" text DEFAULT 'reserved' NOT NULL,
    "source" text,
    "ref" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "org_value_reservations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_value_reservations_org_created" ON "org_value_reservations" ("organization_id","created_at");
