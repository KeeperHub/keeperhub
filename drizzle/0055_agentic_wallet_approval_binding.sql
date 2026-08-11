ALTER TABLE "wallet_approval_requests" ADD COLUMN "bound_recipient" text;--> statement-breakpoint
ALTER TABLE "wallet_approval_requests" ADD COLUMN "bound_amount_micro" text;--> statement-breakpoint
ALTER TABLE "wallet_approval_requests" ADD COLUMN "bound_chain" text;--> statement-breakpoint
ALTER TABLE "wallet_approval_requests" ADD COLUMN "bound_contract" text;