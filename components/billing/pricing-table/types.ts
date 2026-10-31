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
  canManage?: boolean;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  trial?: TrialInfo;
  onPlanUpdated?: () => Promise<void>;
} & (
  | {
      /** Monthly or annual prices, held by the caller across remounts. */
      interval: BillingInterval;
      onIntervalChange: (next: BillingInterval) => void;
    }
  // Without them the table keeps its own choice.
  | { interval?: never; onIntervalChange?: never }
);

export type PlanTierItem = (typeof PLANS)[PlanName]["tiers"][number];
