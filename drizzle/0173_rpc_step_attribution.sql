ALTER TABLE "workflow_execution_logs" ADD COLUMN "rpc_origin" text;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "rpc_config_id" text;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "rpc_failed_over" boolean;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "rpc_origin" text;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "rpc_config_id" text;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "rpc_failed_over" boolean;
