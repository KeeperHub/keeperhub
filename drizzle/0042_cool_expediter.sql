ALTER TABLE "workflows" ADD COLUMN "is_listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "listed_slug" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "listed_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "input_schema" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "output_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "price_usdc_per_call" numeric;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_org_slug" ON "workflows" USING btree ("organization_id","listed_slug") WHERE "workflows"."listed_slug" is not null;