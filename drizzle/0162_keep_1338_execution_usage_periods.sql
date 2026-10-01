CREATE TABLE "execution_usage_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"plan" text NOT NULL,
	"tier" text,
	"execution_limit" integer NOT NULL,
	"workflow_executions" integer NOT NULL,
	"direct_executions" integer NOT NULL,
	"total_executions" integer NOT NULL,
	"overage_count" integer DEFAULT 0 NOT NULL,
	"total_charge_cents" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_usage_periods_org_period" UNIQUE("organization_id","period_start","period_end")
);
--> statement-breakpoint
ALTER TABLE "execution_usage_periods" ADD CONSTRAINT "execution_usage_periods_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_usage_periods_org_start" ON "execution_usage_periods" USING btree ("organization_id","period_start");