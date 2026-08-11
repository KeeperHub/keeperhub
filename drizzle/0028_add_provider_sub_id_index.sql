CREATE INDEX IF NOT EXISTS "idx_org_subscriptions_provider_sub" ON "organization_subscriptions" USING btree ("provider_subscription_id");
