-- Add enabled column to workflows table
ALTER TABLE "workflows" ADD COLUMN "enabled" boolean DEFAULT false NOT NULL;