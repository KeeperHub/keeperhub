CREATE INDEX IF NOT EXISTS idx_exec_logs_execution_id ON workflow_execution_logs (execution_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_started ON workflow_executions (workflow_id, started_at DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows (organization_id);
