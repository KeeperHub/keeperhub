-- Per-org override of any PlanLimits field. Used for custom enterprise contracts
-- (e.g. higher gas credits, custom SLA, dedicated support) on top of plan defaults.
-- See lib/billing/plans.ts for the PlanLimits shape; only specified keys override.
ALTER TABLE "organization_subscriptions" ADD COLUMN "plan_overrides" jsonb;
