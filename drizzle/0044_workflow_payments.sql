CREATE TABLE "workflow_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"payment_hash" text NOT NULL,
	"execution_id" text NOT NULL,
	"amount_usdc" numeric NOT NULL,
	"payer_address" text,
	"creator_wallet_address" text NOT NULL,
	"settled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_payments_hash" ON "workflow_payments" USING btree ("payment_hash");--> statement-breakpoint
CREATE INDEX "idx_workflow_payments_workflow" ON "workflow_payments" USING btree ("workflow_id");