DO $$ BEGIN
  CREATE TYPE "public"."status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "run_id" text;