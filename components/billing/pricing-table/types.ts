import type {
  BillingInterval,
  PLANS,
  PlanName,
  TierKey,
} from "@/lib/billing/plans";

export type GasCreditCapsMap = Record<PlanName, number>;

export type PricingTableProps = {
  currentPlan?: PlanName;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  onPlanUpdated?: () => Promise<void>;
};

export type PlanTierItem = (typeof PLANS)[PlanName]["tiers"][number];
