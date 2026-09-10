CREATE TABLE "pyth_trigger_checkpoints" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"config_hash" text NOT NULL,
	"session_id" text,
	"lease_until" timestamp with time zone,
	"last_publish_time" bigint,
	"armed" boolean DEFAULT false NOT NULL,
	"pending" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pyth_trigger_checkpoints" ADD CONSTRAINT "pyth_trigger_checkpoints_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;