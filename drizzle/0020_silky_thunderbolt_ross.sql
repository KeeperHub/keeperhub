ALTER TABLE "workflow_execution_logs" ADD COLUMN "iteration_index" integer;--> statement-breakpoint
ALTER TABLE "workflow_execution_logs" ADD COLUMN "for_each_node_id" text;