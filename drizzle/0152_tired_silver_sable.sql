CREATE TABLE "workflow_state" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_execution_id" text
);
--> statement-breakpoint
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_state_scope_key" ON "workflow_state" USING btree ("organization_id","workflow_id","key");--> statement-breakpoint
CREATE INDEX "idx_workflow_state_expires_at" ON "workflow_state" USING btree ("expires_at");