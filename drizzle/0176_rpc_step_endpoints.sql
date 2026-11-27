ALTER TABLE "workflow_execution_logs" ADD COLUMN IF NOT EXISTS "rpc_endpoints" jsonb;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN IF NOT EXISTS "rpc_endpoints" jsonb;
