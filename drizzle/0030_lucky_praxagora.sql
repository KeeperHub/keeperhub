CREATE TABLE "execution_debt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"overage_record_id" text NOT NULL,
	"provider_invoice_id" text,
	"debt_executions" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enforced_at" timestamp NOT NULL,
	"cleared_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_debt_overage_record_id_unique" UNIQUE("overage_record_id")
);
--> statement-breakpoint
ALTER TABLE "overage_billing_records" ADD COLUMN "provider_invoice_id" text;--> statement-breakpoint
ALTER TABLE "execution_debt" ADD CONSTRAINT "execution_debt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_debt" ADD CONSTRAINT "execution_debt_overage_record_id_overage_billing_records_id_fk" FOREIGN KEY ("overage_record_id") REFERENCES "public"."overage_billing_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_debt_org_status" ON "execution_debt" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_execution_debt_invoice" ON "execution_debt" USING btree ("provider_invoice_id");