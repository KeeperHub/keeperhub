import { toast } from "sonner";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  PLANS,
  type PlanName,
  type TierKey,
  TRIAL_PLAN_NAME,
} from "@/lib/billing/plans";
import type { PlanTierItem, TrialInfo } from "./types";

export function formatPrice(price: number): string {
  return `$${price}`;
}

export function getTierPrice(
  tier: PlanTierItem,
  interval: BillingInterval
): number {
  return interval === "monthly" ? tier.monthlyPrice : tier.monthlyPriceAnnual;
}

export function computeDisplayPrice(
  planName: PlanName,
  activeTier: PlanTierItem | undefined,
  interval: BillingInterval
): number | null {
  if (planName === "free") {
    return 0;
  }
  if (planName === "enterprise") {
    return null;
  }
  if (!activeTier) {
    return 0;
  }
  return getTierPrice(activeTier, interval);
}

/**
 * Whether a plan/tier selection is the free-trial offer rather than a pay-now
 * purchase. The trial rides on one plan and one tier only: Pro at the tier the
 * server resolved (25k by default). Every other Pro tier, and every other plan,
 * is paid. Display and checkout intent both read this; the checkout route
 * re-checks eligibility server-side.
 */
export function isTrialSelection(
  trial: TrialInfo | undefined,
  planName: PlanName,
  tierKey: TierKey | null
): boolean {
  return (
    trial?.eligible === true &&
    planName === TRIAL_PLAN_NAME &&
    tierKey === trial.tier
  );
}

// `trialDays` is set only when the card's current selection is the trial offer
// (Pro at the server-resolved trial tier for an eligible org).
export function getButtonLabel(
  planName: PlanName,
  isCurrent: boolean,
  loading: boolean,
  hasSubscription: boolean,
  trialDays?: number | null
): string {
  if (loading) {
    return hasSubscription ? "Updating..." : "Redirecting...";
  }
  if (isCurrent) {
    return "Current Plan";
  }
  if (trialDays) {
    return `Start ${trialDays}-day free trial`;
  }
  if (planName === "free") {
    return hasSubscription ? "Downgrade to Free" : "Free";
  }
  if (planName === "enterprise") {
    return "Talk to us";
  }
  return "Choose plan";
}

export function getExecutionsDisplay(
  planName: PlanName,
  activeTier: PlanTierItem | undefined
): string | null {
  if (planName === "enterprise") {
    return "Custom";
  }
  if (planName === "free") {
    return PLANS.free.features.maxExecutionsPerMonth.toLocaleString();
  }
  if (activeTier) {
    return activeTier.executions.toLocaleString();
  }
  return null;
}

export async function startCheckout(
  plan: PlanName,
  tier: TierKey | null,
  interval: BillingInterval,
  options?: { trial?: boolean }
): Promise<boolean> {
  const response = await fetch(BILLING_API.CHECKOUT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan,
      tier,
      interval,
      trial: options?.trial === true,
    }),
  });

  const data = (await response.json()) as {
    url?: string;
    updated?: boolean;
    error?: string;
  };

  if (!response.ok) {
    toast.error(data.error ?? "Failed to process plan change");
    return false;
  }

  if (data.updated) {
    toast.success(
      "Plan updated successfully! Changes take effect immediately."
    );
    return true;
  }

  if (data.url) {
    window.location.href = data.url;
  }

  return false;
}

export function resolveExecutions(
  planName: PlanName | undefined,
  tierKey: TierKey | null | undefined
): number {
  const planDef = planName ? PLANS[planName] : PLANS.free;
  const tierDef = tierKey
    ? planDef.tiers.find((t) => t.key === tierKey)
    : undefined;
  return tierDef ? tierDef.executions : planDef.features.maxExecutionsPerMonth;
}

export function isCurrentPlan(
  planName: PlanName,
  selectedTier: TierKey | null,
  interval: BillingInterval,
  currentPlan: PlanName | undefined,
  currentTier: TierKey | null | undefined,
  currentInterval: BillingInterval | null | undefined
): boolean {
  if (currentPlan !== planName) {
    return false;
  }
  if (planName === "free") {
    return true;
  }
  if (currentTier === undefined || currentInterval === undefined) {
    return false;
  }
  return currentTier === selectedTier && currentInterval === interval;
}

export async function cancelSubscription(): Promise<{
  success: boolean;
  periodEnd?: string | null;
}> {
  const response = await fetch(BILLING_API.CANCEL, {
    method: "POST",
  });
  const data = (await response.json()) as {
    canceled?: boolean;
    periodEnd?: string | null;
    error?: string;
  };
  if (!response.ok) {
    toast.error(data.error ?? "Failed to cancel subscription");
    return { success: false };
  }
  return { success: true, periodEnd: data.periodEnd };
}
