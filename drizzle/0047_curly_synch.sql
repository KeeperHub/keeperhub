ALTER TABLE "workflow_payments" ADD COLUMN "protocol" varchar(10) DEFAULT 'x402' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_payments" ADD COLUMN "chain" text DEFAULT 'base' NOT NULL;