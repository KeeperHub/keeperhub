CREATE TABLE "agentic_wallet_daily_spend" (
	"sub_org_id" text NOT NULL,
	"day_utc" date NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "agentic_wallet_daily_spend_sub_org_id_day_utc_pk" PRIMARY KEY("sub_org_id","day_utc")
);
--> statement-breakpoint
ALTER TABLE "agentic_wallet_daily_spend" ADD CONSTRAINT "agentic_wallet_daily_spend_sub_org_id_agentic_wallets_sub_org_id_fk" FOREIGN KEY ("sub_org_id") REFERENCES "public"."agentic_wallets"("sub_org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agentic_wallet_daily_spend_day" ON "agentic_wallet_daily_spend" USING btree ("day_utc");
