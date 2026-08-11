ALTER TABLE "pending_transactions" DROP CONSTRAINT "pending_transactions_pkey";--> statement-breakpoint
ALTER TABLE "pending_transactions" DROP CONSTRAINT "pending_tx_wallet_chain_nonce";--> statement-breakpoint
ALTER TABLE "pending_transactions" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "pending_transactions" ADD CONSTRAINT "pending_transactions_wallet_address_chain_id_nonce_pk" PRIMARY KEY("wallet_address","chain_id","nonce");