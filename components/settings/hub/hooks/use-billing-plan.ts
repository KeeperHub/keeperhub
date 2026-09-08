"use client";

import { useCallback, useState } from "react";
import type {
  GasCreditCapsMap,
  TrialInfo,
} from "@/components/billing/pricing-table/types";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

type SubscriptionResponse = {
  subscription: { plan: string; tier: string | null; interval: string | null };
  gasCreditCaps?: GasCreditCapsMap;
  trial?: TrialInfo;
};

export type BillingPlanState = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
  gasCreditCaps: GasCreditCapsMap | undefined;
  trial: TrialInfo | undefined;
  loading: boolean;
  /** Bumped after a plan change so the child panels remount and refetch. */
  refreshKey: number;
  refresh: () => Promise<void>;
};

type PlanSnapshot = {
  plan: PlanName;
  tier: TierKey | null;
  interval: BillingInterval | null;
  gasCreditCaps: GasCreditCapsMap | undefined;
  trial: TrialInfo | undefined;
};

export function useBillingPlan(): BillingPlanState {
  const { organizationId } = useSettingsContext();
  const [refreshKey, setRefreshKey] = useState(0);

  const section = useCachedSection<PlanSnapshot>(
    organizationId ? `billing-plan:${organizationId}` : null,
    async () => {
      const response = await fetch(BILLING_API.SUBSCRIPTION);
      if (!response.ok) {
        throw new Error("Could not load the plan");
      }
      const data = (await response.json()) as SubscriptionResponse;
      return {
        gasCreditCaps: data.gasCreditCaps,
        interval:
          data.subscription.interval === "monthly" ||
          data.subscription.interval === "yearly"
            ? data.subscription.interval
            : null,
        plan: parsePlanName(data.subscription.plan),
        tier: parseTierKey(data.subscription.tier),
        trial: data.trial,
      };
    }
  );

  const snapshot = section.data;
  const plan = snapshot?.plan ?? "free";
  const tier = snapshot?.tier ?? null;
  const interval = snapshot?.interval ?? null;
  const gasCreditCaps = snapshot?.gasCreditCaps;
  const trial = snapshot?.trial;
  const loading = section.loading;

  const refetch = section.refetch;
  const refresh = useCallback(async (): Promise<void> => {
    await refetch();
    setRefreshKey((k) => k + 1);
  }, [refetch]);

  return {
    gasCreditCaps,
    interval,
    loading,
    plan,
    refresh,
    refreshKey,
    tier,
    trial,
  };
}
