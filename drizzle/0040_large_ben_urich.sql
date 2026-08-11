CREATE TABLE "gas_credit_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"allocated_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gas_credit_alloc_org_period" UNIQUE("organization_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "gas_credit_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"execution_id" text,
	"gas_used" text NOT NULL,
	"gas_price_wei" text NOT NULL,
	"gas_cost_wei" text NOT NULL,
	"gas_cost_micro_usd" text NOT NULL,
	"eth_price_usd" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gas_usage_org_tx" UNIQUE("organization_id","tx_hash")
);
--> statement-breakpoint
CREATE TABLE "gas_sponsorship_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"delegation_tx_hash" text NOT NULL,
	"implementation_address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delegated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gas_delegation_org_chain" UNIQUE("organization_id","chain_id")
);
--> statement-breakpoint
ALTER TABLE "gas_credit_allocations" ADD CONSTRAINT "gas_credit_allocations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gas_credit_usage" ADD CONSTRAINT "gas_credit_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gas_sponsorship_delegations" ADD CONSTRAINT "gas_sponsorship_delegations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gas_credit_alloc_org" ON "gas_credit_allocations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_gas_usage_org_created" ON "gas_credit_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_gas_delegation_org" ON "gas_sponsorship_delegations" USING btree ("organization_id");