ALTER TABLE "workflows" ADD COLUMN "workflow_type" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "chain" text;