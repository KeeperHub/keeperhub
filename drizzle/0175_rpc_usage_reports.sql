CREATE TABLE IF NOT EXISTS "organization_rpc_usage_reports" (
	"report_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_rpc_usage_reports_received" ON "organization_rpc_usage_reports" USING btree ("received_at");
