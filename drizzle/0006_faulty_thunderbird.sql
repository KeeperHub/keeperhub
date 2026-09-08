-- KEEP-1154: Chains, User RPC Preferences, and Explorer Configs
-- Creates chain configuration with separate explorer config table

CREATE TABLE "chains" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"chain_type" text DEFAULT 'evm' NOT NULL,
	"default_primary_rpc" text NOT NULL,
	"default_fallback_rpc" text,
	"default_primary_wss" text,
	"default_fallback_wss" text,
	"is_testnet" boolean DEFAULT false,
	"is_enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chains_chain_id_unique" UNIQUE("chain_id")
);
--> statement-breakpoint
CREATE TABLE "user_rpc_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"primary_rpc_url" text NOT NULL,
	"fallback_rpc_url" text,
	"primary_wss_url" text,
	"fallback_wss_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explorer_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"chain_type" text DEFAULT 'evm' NOT NULL,
	"explorer_url" text,
	"explorer_api_type" text,
	"explorer_api_url" text,
	"explorer_tx_path" text DEFAULT '/tx/{hash}',
	"explorer_address_path" text DEFAULT '/address/{address}',
	"explorer_contract_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "explorer_configs_chain_id_unique" UNIQUE("chain_id")
);
--> statement-breakpoint
ALTER TABLE "user_rpc_preferences" ADD CONSTRAINT "user_rpc_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "explorer_configs" ADD CONSTRAINT "explorer_configs_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_chains_chain_id" ON "chains" USING btree ("chain_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_rpc_user_chain" ON "user_rpc_preferences" USING btree ("user_id","chain_id");
--> statement-breakpoint
CREATE INDEX "idx_user_rpc_user_id" ON "user_rpc_preferences" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_explorer_configs_chain_id" ON "explorer_configs" USING btree ("chain_id");
