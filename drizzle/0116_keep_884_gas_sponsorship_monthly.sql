CREATE TABLE "gas_sponsorship_monthly" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"month_start" timestamp NOT NULL,
	"sponsored_wei" text NOT NULL,
	"sponsored_micro_usd" text NOT NULL,
	"tx_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gas_sponsorship_monthly_org_month_chain" UNIQUE("organization_id","month_start","chain_id")
);
--> statement-breakpoint
ALTER TABLE "gas_sponsorship_monthly" ADD CONSTRAINT "gas_sponsorship_monthly_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gas_sponsorship_monthly_org_month" ON "gas_sponsorship_monthly" USING btree ("organization_id","month_start");
