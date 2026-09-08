ALTER TABLE "para_wallets" DROP CONSTRAINT "para_wallets_organization_id_unique";--> statement-breakpoint
ALTER TABLE "para_wallets" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "para_wallets_org_active_unique" ON "para_wallets" USING btree ("organization_id") WHERE "para_wallets"."is_active" = true;