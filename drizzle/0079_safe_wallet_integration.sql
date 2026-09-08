CREATE TABLE "safe_role_allowances" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"protocol_slug" text NOT NULL,
	"allowance_key" text NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"max_refill_wei" text NOT NULL,
	"refill_wei" text NOT NULL,
	"period_seconds" integer NOT NULL,
	"last_chain_balance_wei" text,
	"last_chain_timestamp" timestamp,
	"last_reconciled_at" timestamp,
	"last_applied_tx_hash" text,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_role_direct_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_address" text,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"counterparty" text NOT NULL,
	"amount_human" text NOT NULL,
	"period_seconds" integer NOT NULL,
	"status" text DEFAULT 'allowed' NOT NULL,
	"last_applied_tx_hash" text,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_role_protocols" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"protocol_slug" text NOT NULL,
	"template_slug" text NOT NULL,
	"allowed_token_symbols" jsonb NOT NULL,
	"target_addresses" jsonb NOT NULL,
	"allowed_selectors" jsonb NOT NULL,
	"status" text DEFAULT 'allowed' NOT NULL,
	"last_applied_tx_hash" text,
	"last_updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_wallet_id" text NOT NULL,
	"role_type" text DEFAULT 'automation' NOT NULL,
	"role_key" text NOT NULL,
	"roles_modifier_address" text NOT NULL,
	"delegate_address" text NOT NULL,
	"installed_tx_hash" text,
	"last_reconciled_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"safe_address" text NOT NULL,
	"owner_wallet_id" text,
	"owners" jsonb NOT NULL,
	"threshold" integer NOT NULL,
	"salt_nonce" text NOT NULL,
	"safe_version" text DEFAULT '1.4.1' NOT NULL,
	"singleton_address" text NOT NULL,
	"factory_address" text NOT NULL,
	"deployment_tx_hash" text,
	"deployment_block" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"deployed_at" timestamp,
	"is_signing_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_tokens" ADD COLUMN "safe_wallet_id" text;--> statement-breakpoint
ALTER TABLE "safe_role_allowances" ADD CONSTRAINT "safe_role_allowances_role_id_safe_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."safe_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_role_direct_rules" ADD CONSTRAINT "safe_role_direct_rules_role_id_safe_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."safe_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_role_protocols" ADD CONSTRAINT "safe_role_protocols_role_id_safe_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."safe_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_roles" ADD CONSTRAINT "safe_roles_safe_wallet_id_safe_wallets_id_fk" FOREIGN KEY ("safe_wallet_id") REFERENCES "public"."safe_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_wallets" ADD CONSTRAINT "safe_wallets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_wallets" ADD CONSTRAINT "safe_wallets_owner_wallet_id_para_wallets_id_fk" FOREIGN KEY ("owner_wallet_id") REFERENCES "public"."para_wallets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "safe_role_allowances_role_key_unique" ON "safe_role_allowances" USING btree ("role_id","allowance_key");--> statement-breakpoint
CREATE INDEX "idx_safe_role_allowances_role" ON "safe_role_allowances" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_role_direct_rules_role_kind_token_cp_unique" ON "safe_role_direct_rules" USING btree ("role_id","kind","token_address","counterparty");--> statement-breakpoint
CREATE INDEX "idx_safe_role_direct_rules_role" ON "safe_role_direct_rules" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_role_protocols_role_slug_unique" ON "safe_role_protocols" USING btree ("role_id","protocol_slug");--> statement-breakpoint
CREATE INDEX "idx_safe_role_protocols_role" ON "safe_role_protocols" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_roles_safe_type_unique" ON "safe_roles" USING btree ("safe_wallet_id","role_type");--> statement-breakpoint
CREATE INDEX "idx_safe_roles_safe" ON "safe_roles" USING btree ("safe_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_wallets_org_chain_unique" ON "safe_wallets" USING btree ("organization_id","chain_id");--> statement-breakpoint
CREATE INDEX "idx_safe_wallets_org" ON "safe_wallets" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "organization_tokens" ADD CONSTRAINT "organization_tokens_safe_wallet_id_safe_wallets_id_fk" FOREIGN KEY ("safe_wallet_id") REFERENCES "public"."safe_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_tokens_safe" ON "organization_tokens" USING btree ("safe_wallet_id");
