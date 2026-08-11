ALTER TABLE "direct_executions" ALTER COLUMN "network" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "gas_price_wei" text;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "estimated_cost_usd" text;--> statement-breakpoint
ALTER TABLE "direct_executions" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;