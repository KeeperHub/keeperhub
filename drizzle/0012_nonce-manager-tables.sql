CREATE TABLE "organization_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "organization_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "pending_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"nonce" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"execution_id" text NOT NULL,
	"workflow_id" text,
	"gas_price" text,
	"submitted_at" timestamp with time zone DEFAULT now(),
	"confirmed_at" timestamp with time zone,
	"status" text DEFAULT 'pending',
	CONSTRAINT "pending_tx_wallet_chain_nonce" UNIQUE("wallet_address","chain_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "wallet_locks" (
	"wallet_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	CONSTRAINT "wallet_locks_wallet_address_chain_id_pk" PRIMARY KEY("wallet_address","chain_id")
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pending_tx_status" ON "pending_transactions" USING btree ("wallet_address","chain_id","status");--> statement-breakpoint
CREATE INDEX "idx_pending_tx_execution" ON "pending_transactions" USING btree ("execution_id");