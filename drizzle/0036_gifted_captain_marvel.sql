CREATE TABLE "key_export_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"scopes" jsonb NOT NULL,
	"grant_types" jsonb NOT NULL,
	"organization_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "para_wallets" RENAME COLUMN "wallet_id" TO "para_wallet_id";--> statement-breakpoint
ALTER TABLE "para_wallets" ALTER COLUMN "para_wallet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "para_wallets" ALTER COLUMN "user_share" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "para_wallets" ADD COLUMN "provider" text NOT NULL DEFAULT 'para';
ALTER TABLE "para_wallets" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "para_wallets" ADD COLUMN "turnkey_sub_org_id" text;--> statement-breakpoint
ALTER TABLE "para_wallets" ADD COLUMN "turnkey_wallet_id" text;--> statement-breakpoint
ALTER TABLE "para_wallets" ADD COLUMN "turnkey_private_key_id" text;--> statement-breakpoint
ALTER TABLE "key_export_codes" ADD CONSTRAINT "key_export_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_refresh_tokens_client" ON "mcp_oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_refresh_tokens_user" ON "mcp_oauth_refresh_tokens" USING btree ("user_id");