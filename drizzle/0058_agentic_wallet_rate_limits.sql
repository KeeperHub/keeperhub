CREATE TABLE "agentic_wallet_rate_limits" (
	"key" text NOT NULL,
	"bucket_start" timestamp NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agentic_wallet_rate_limits_key_bucket_start_pk" PRIMARY KEY("key","bucket_start")
);
--> statement-breakpoint
CREATE INDEX "idx_agentic_wallet_rate_limits_bucket" ON "agentic_wallet_rate_limits" USING btree ("bucket_start");