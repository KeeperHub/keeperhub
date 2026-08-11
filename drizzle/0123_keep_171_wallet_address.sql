-- Wallet (SIWE) login support. `wallet_address` links one or more Ethereum
-- addresses to a user; Better Auth's SIWE plugin reads/writes it during
-- /siwe/verify. `users.display_name_confirmed` gates the rename modal: wallet
-- accounts start with a generated handle and confirm or edit it on first
-- login, so the flag stays false until they do.

CREATE TABLE "wallet_address" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "address" text NOT NULL,
  "chain_id" integer NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_address_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "idx_wallet_address_user_id" ON "wallet_address" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wallet_address_address_unique" ON "wallet_address" ("address");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name_confirmed" boolean DEFAULT false NOT NULL;
