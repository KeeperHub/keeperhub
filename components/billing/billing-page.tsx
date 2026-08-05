"use client";

import { CreditCard, LogIn } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { BILLING_API, PAID_PLANS } from "@/lib/billing/constants";
import {
  type BillingInterval,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import { useOrganization } from "@/lib/hooks/use-organization";
import { BillingDetails } from "./billing-details";
import { BillingHistory } from "./billing-history";
import { BillingStatus } from "./billing-status";
import { PricingTable } from "./pricing-table";
import type { GasCreditCapsMap, TrialInfo } from "./pricing-table/types";

type SubscriptionResponse = {
  subscription: {
    plan: string;
    tier: string | null;
    interval: string | null;
  };
  gasCreditCaps?: GasCreditCapsMap;
  trial?: TrialInfo;
};

function AuthGate({
  error,
}: {
  error: "AUTH_REQUIRED" | "ORG_REQUIRED";
}): React.ReactElement {
  const isAuthRequired = error === "AUTH_REQUIRED";

  return (
    <div
      className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar"
      data-page-state="ready"
      data-testid="billing-page-auth-gate"
    >
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-2xl bg-muted">
            {isAuthRequired ? (
              <LogIn className="size-10 text-muted-foreground" />
            ) : (
              <CreditCard className="size-10 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {isAuthRequired
                ? "Sign in to view billing"
                : "Organization required"}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {isAuthRequired
                ? "Sign in to your account to manage your subscription and view billing history."
                : "Create or join an organization to manage billing."}
            </p>
          </div>
          {!isAuthRequired && (
            <Button asChild>
              <Link href="/">Get Started</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BillingPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const { data: session, isPending: sessionPending } = useSession();
  const { organization } = useOrganization();
  const orgId = organization?.id;
  const [currentPlan, setCurrentPlan] = useState<PlanName>("free");
  const [currentTier, setCurrentTier] = useState<TierKey | null>(null);
  const [currentInterval, setCurrentInterval] =
    useState<BillingInterval | null>(null);
  const [gasCreditCaps, setGasCreditCaps] = useState<
    GasCreditCapsMap | undefined
  >(undefined);
  const [trial, setTrial] = useState<TrialInfo | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [planLoaded, setPlanLoaded] = useState(false);
  const isAnonymous = !session?.user || session.user.isAnonymous;

  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (checkout === "success") {
      toast.success("Subscription activated successfully!");
      window.history.replaceState({}, "", window.location.pathname);
      // Heuristic delay: Stripe needs a moment after Checkout to attach the
      // payment method where getBillingDetails can read it back via the API
      // cascade. 2s works in practice but is a race, not a guarantee. The
      // robust fix is to persist payment method details in our DB on the
      // checkout.session.completed webhook and read from DB instead of
      // hitting Stripe here.
      const timer = setTimeout(() => setRefreshKey((k) => k + 1), 2000);
      return () => clearTimeout(timer);
    }
    if (checkout === "canceled") {
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
        setTrial(data.trial);
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
    setTrial(undefined);
    setPlanLoaded(false);
    setRefreshKey((k) => k + 1);
    fetchPlan().catch(() => undefined);
  }, [fetchPlan, orgId]);

  async function handlePlanUpdated(): Promise<void> {
    await fetchPlan();
    setRefreshKey((k) => k + 1);
  }

  if (sessionPending) {
    return (
      <div
        className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar"
        data-page-state="loading"
        data-testid="billing-page"
      />
    );
  }

  if (isAnonymous) {
    return <AuthGate error="AUTH_REQUIRED" />;
  }

  // data-page-state tracks subscription plan fetch only.
  // BillingStatus and BillingHistory have independent async loads.
  return (
    <div
      className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar"
      data-page-state={planLoaded ? "ready" : "loading"}
      data-testid="billing-page"
    >
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="container mx-auto max-w-7xl space-y-8 px-4 py-8 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <div>
            <h1 className="text-2xl font-bold">Billing</h1>
            <p className="text-muted-foreground mt-1">
              Manage your subscription and billing details.
            </p>
          </div>

          <BillingStatus key={`status-${String(refreshKey)}`} />

          {/* Stripe billing history and payment method only apply to paid
              plans. Free orgs (including free + pay-as-you-go, whose charges
              show in the pay-as-you-go panel) have neither. */}
          {PAID_PLANS.has(currentPlan) && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
              <BillingHistory key={`history-${String(refreshKey)}`} />
              <BillingDetails key={`details-${String(refreshKey)}`} />
            </div>
          )}

          <div className="border-t border-border/50 pt-8" id="plans-section">
            <h2 className="text-xl font-semibold mb-4">Plans</h2>
            {/* The trial tier is part of the key: it decides the Pro card's
                default selection, which is initial state inside the table. */}
            <PricingTable
              currentInterval={currentInterval}
              currentPlan={currentPlan}
              currentTier={currentTier}
              gasCreditCaps={gasCreditCaps}
              key={`${currentPlan}-${currentTier ?? "none"}-${currentInterval ?? "none"}-${trial?.eligible === true ? trial.tier : "no-trial"}-${String(refreshKey)}`}
              onPlanUpdated={handlePlanUpdated}
              trial={trial}
            />
          </div>

          <div className="flex justify-center border-t border-border/50 pt-8">
            <a
              className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
              href="https://keeperhub.com/pricing"
              rel="noopener"
              target="_blank"
            >
              Pricing FAQ and comparison -&gt;
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
