CREATE TABLE "payg_config" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"daily_cap_raw" text DEFAULT '0' NOT NULL,
	"period_cap_raw" text DEFAULT '0' NOT NULL,
	"chain_id" integer DEFAULT 8453 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payg_config_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "payg_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"amount_raw" text NOT NULL,
	"tx_hash" text,
	"chain_id" integer NOT NULL,
	"payer_address" text NOT NULL,
	"treasury_address" text NOT NULL,
	"status" text DEFAULT 'settled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payg_payments_org_execution" UNIQUE("organization_id","execution_id")
);
--> statement-breakpoint
ALTER TABLE "payg_config" ADD CONSTRAINT "payg_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payg_payments" ADD CONSTRAINT "payg_payments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payg_config_org" ON "payg_config" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_payg_payments_org_created" ON "payg_payments" USING btree ("organization_id","created_at");