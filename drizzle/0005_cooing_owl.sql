CREATE TABLE "workflow_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"next_run_at" timestamp with time zone,
	"run_count" text DEFAULT '0',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_schedules_workflow_id_unique" UNIQUE("workflow_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "total_steps" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "completed_steps" text DEFAULT '0';--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "current_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "current_node_name" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "last_successful_node_id" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "last_successful_node_name" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "execution_trace" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_enabled" ON "workflow_schedules" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_schedules_workflow" ON "workflow_schedules" USING btree ("workflow_id");
