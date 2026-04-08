"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import { useOrganization } from "@/lib/hooks/use-organization";
import { BillingHistory } from "./billing-history";
import { BillingStatus } from "./billing-status";
import { PricingTable } from "./pricing-table";
import type { GasCreditCapsMap } from "./pricing-table/types";

type SubscriptionResponse = {
  subscription: {
    plan: string;
    tier: string | null;
    interval: string | null;
  };
  gasCreditCaps?: GasCreditCapsMap;
};

export function BillingPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const [currentPlan, setCurrentPlan] = useState<PlanName>("free");
  const [currentTier, setCurrentTier] = useState<TierKey | null>(null);
  const [currentInterval, setCurrentInterval] =
    useState<BillingInterval | null>(null);
  const [gasCreditCaps, setGasCreditCaps] = useState<
    GasCreditCapsMap | undefined
  >(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [planLoaded, setPlanLoaded] = useState(false);

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (checkout === "success") {
      toast.success("Subscription activated successfully!");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (checkout === "canceled") {
      toast.info("Checkout was canceled.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [searchParams]);

  const fetchPlan = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(BILLING_API.SUBSCRIPTION);
      if (response.ok) {
        const data = (await response.json()) as SubscriptionResponse;
        setCurrentPlan(parsePlanName(data.subscription.plan));
        setCurrentTier(parseTierKey(data.subscription.tier));
        setCurrentInterval(
          data.subscription.interval === "monthly" ||
            data.subscription.interval === "yearly"
            ? data.subscription.interval
            : null
        );
        setGasCreditCaps(data.gasCreditCaps);
      }
    } catch (error) {
      console.error("[Billing] Failed to fetch plan:", error);
    } finally {
      setPlanLoaded(true);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId intentionally triggers re-fetch on org switch
  useEffect(() => {
    setCurrentPlan("free");
    setCurrentTier(null);
    setCurrentInterval(null);
    setPlanLoaded(false);
    setRefreshKey((k) => k + 1);
    fetchPlan().catch(() => undefined);
  }, [fetchPlan, orgId]);

  async function handlePlanUpdated(): Promise<void> {
    await fetchPlan();
    setRefreshKey((k) => k + 1);
  }

  // data-page-state tracks subscription plan fetch only.
  // BillingStatus and BillingHistory have independent async loads.
  return (
    <div
      className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar"
      data-page-state={planLoaded ? "ready" : "loading"}
      data-testid="billing-page"
    >
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-sidebar-width,60px)]">
        <div className="container mx-auto max-w-7xl space-y-8 px-4 py-8 pt-20">
          <div>
            <h1 className="text-2xl font-bold">Billing</h1>
            <p className="text-muted-foreground mt-1">
              Manage your subscription and billing details.
            </p>
          </div>

          <BillingStatus key={`status-${String(refreshKey)}`} />

          <BillingHistory key={`history-${String(refreshKey)}`} />

          <div className="border-t border-border/50 pt-8" id="plans-section">
            <h2 className="text-xl font-semibold mb-4">Plans</h2>
            <PricingTable
              currentInterval={currentInterval}
              currentPlan={currentPlan}
              currentTier={currentTier}
              gasCreditCaps={gasCreditCaps}
              key={`${currentPlan}-${currentTier ?? "none"}-${currentInterval ?? "none"}-${String(refreshKey)}`}
              onPlanUpdated={handlePlanUpdated}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
