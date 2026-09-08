CREATE TABLE "agentic_wallet_hmac_secrets" (
	"sub_org_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	CONSTRAINT "agentic_wallet_hmac_secrets_sub_org_id_key_version_pk" PRIMARY KEY("sub_org_id","key_version")
);
--> statement-breakpoint
ALTER TABLE "agentic_wallet_hmac_secrets" ADD CONSTRAINT "agentic_wallet_hmac_secrets_sub_org_id_agentic_wallets_sub_org_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."agentic_wallets"("sub_org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Phase 37: backfill existing plaintext hmac_secret rows into the new
-- versioned + encrypted table at key_version=1. The runtime in
-- hmac-secret-store.ts detects the __PLAINTEXT_BACKFILL__ prefix on
-- first read and re-encrypts the row in place. The original column
-- stays populated for safety until KEEP-NEW-3 drops it.
INSERT INTO "agentic_wallet_hmac_secrets" (sub_org_id, key_version, secret_ciphertext, created_at, expires_at)
SELECT sub_org_id, 1, '__PLAINTEXT_BACKFILL__:' || hmac_secret, now(), NULL
FROM "agentic_wallets"
WHERE hmac_secret IS NOT NULL AND length(hmac_secret) = 64
ON CONFLICT (sub_org_id, key_version) DO NOTHING;
--> statement-breakpoint