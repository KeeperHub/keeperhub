CREATE TABLE "overage_billing_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"execution_limit" integer NOT NULL,
	"total_executions" integer NOT NULL,
	"overage_count" integer NOT NULL,
	"overage_rate_cents" integer NOT NULL,
	"total_charge_cents" integer NOT NULL,
	"provider_invoice_item_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "overage_billing_org_period" UNIQUE("organization_id","period_start","period_end")
);
--> statement-breakpoint
ALTER TABLE "overage_billing_records" ADD CONSTRAINT "overage_billing_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_overage_billing_org" ON "overage_billing_records" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_overage_billing_status" ON "overage_billing_records" USING btree ("status");