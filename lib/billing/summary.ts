import { BILLING_API } from "./constants";
import {
  type BillingInterval,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "./plans";

type SubscriptionResponse = {
  subscription: {
    plan: string;
    tier: string | null;
    interval: string | null;
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  usage: { executionsUsed: number; executionLimit: number };
  gasCredits?: {
    totalCents: number;
    usedCents: number;
    remainingCents: number;
  };
};

export type BillingSummary = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
  status: string;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  executionsUsed: number;
  executionLimit: number;
  gasUsedCents: number;
  gasTotalCents: number;
};

/** Shared by the billing section and the toolbar digest so one fetch serves both. */
export function billingSummaryCacheKey(
  organizationId: string | null
): string | null {
  return organizationId ? `billing-summary:${organizationId}` : null;
}

export async function fetchBillingSummary(): Promise<BillingSummary | null> {
  const res = await fetch(BILLING_API.SUBSCRIPTION);
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as SubscriptionResponse;
  return {
    cancelAtPeriodEnd: data.subscription.cancelAtPeriodEnd,
    executionLimit: data.usage.executionLimit,
    executionsUsed: data.usage.executionsUsed,
    gasTotalCents: data.gasCredits?.totalCents ?? 0,
    gasUsedCents: data.gasCredits?.usedCents ?? 0,
    interval:
      data.subscription.interval === "monthly" ||
      data.subscription.interval === "yearly"
        ? data.subscription.interval
        : null,
    plan: parsePlanName(data.subscription.plan),
    renewsAt: data.subscription.currentPeriodEnd,
    status: data.subscription.status,
    tier: parseTierKey(data.subscription.tier),
  };
}
