CREATE TYPE "public"."approval_risk_level" AS ENUM('auto', 'ask', 'block');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "agentic_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"sub_org_id" text NOT NULL,
	"wallet_address_base" text NOT NULL,
	"wallet_address_tempo" text NOT NULL,
	"linked_user_id" text,
	"linked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentic_wallets_sub_org_id_unique" UNIQUE("sub_org_id")
);
--> statement-breakpoint
CREATE TABLE "wallet_approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"sub_org_id" text NOT NULL,
	"operation_payload" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"risk_level" "approval_risk_level" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "agentic_wallets" ADD CONSTRAINT "agentic_wallets_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_approval_requests" ADD CONSTRAINT "wallet_approval_requests_sub_org_id_agentic_wallets_sub_org_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."agentic_wallets"("sub_org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_approval_requests" ADD CONSTRAINT "wallet_approval_requests_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agentic_wallets_linked_user" ON "agentic_wallets" USING btree ("linked_user_id");--> statement-breakpoint
CREATE INDEX "idx_agentic_wallets_wallet_base" ON "agentic_wallets" USING btree ("wallet_address_base");--> statement-breakpoint
CREATE INDEX "idx_agentic_wallets_wallet_tempo" ON "agentic_wallets" USING btree ("wallet_address_tempo");--> statement-breakpoint
CREATE INDEX "idx_wallet_approval_sub_org" ON "wallet_approval_requests" USING btree ("sub_org_id");--> statement-breakpoint
CREATE INDEX "idx_wallet_approval_status" ON "wallet_approval_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_wallet_approval_created" ON "wallet_approval_requests" USING btree ("created_at");