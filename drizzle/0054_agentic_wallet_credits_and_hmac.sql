CREATE TABLE "agentic_wallet_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"sub_org_id" text NOT NULL,
	"amount_usdc_cents" integer NOT NULL,
	"allocation_reason" text DEFAULT 'onboard_initial' NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentic_wallets" ADD COLUMN "hmac_secret" text;--> statement-breakpoint
ALTER TABLE "agentic_wallet_credits" ADD CONSTRAINT "agentic_wallet_credits_sub_org_id_agentic_wallets_sub_org_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."agentic_wallets"("sub_org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agentic_wallet_credits_sub_org" ON "agentic_wallet_credits" USING btree ("sub_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agentic_wallet_credits_sub_org_reason" ON "agentic_wallet_credits" USING btree ("sub_org_id","allocation_reason");