import type {
  BillingInterval,
  PLANS,
  PlanName,
  TierKey,
} from "@/lib/billing/plans";

export type GasCreditCapsMap = Record<PlanName, number>;

// First-time-subscriber trial hint from the subscription API. Display only;
// the checkout route re-checks eligibility server-side. `tier` is the
// server-resolved Pro tier the trial applies to.
export type TrialInfo = {
  eligible: boolean;
  days: number;
  tier: TierKey;
};

export type PricingTableProps = {
  currentPlan?: PlanName;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  trial?: TrialInfo;
  onPlanUpdated?: () => Promise<void>;
};

export type PlanTierItem = (typeof PLANS)[PlanName]["tiers"][number];
