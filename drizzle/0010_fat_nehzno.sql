CREATE TABLE "supported_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer NOT NULL,
	"logo_url" text,
	"is_stablecoin" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "supported_tokens_chain_address" UNIQUE("chain_id","token_address")
);
--> statement-breakpoint
CREATE INDEX "idx_supported_tokens_chain" ON "supported_tokens" USING btree ("chain_id");