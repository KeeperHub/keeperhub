ALTER TABLE "workflow_executions"
  ALTER COLUMN "duration" TYPE numeric USING "duration"::numeric;

ALTER TABLE "workflow_execution_logs"
  ALTER COLUMN "duration" TYPE numeric USING "duration"::numeric;
