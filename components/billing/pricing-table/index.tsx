"use client";

import { useState } from "react";
import type { BillingInterval } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { PlanCard } from "./plan-card";
import type { PricingTableProps } from "./types";

export function PricingTable({
  currentPlan = "free",
  currentTier,
  currentInterval,
  gasCreditCaps,
  onPlanUpdated,
}: PricingTableProps): React.ReactElement {
  const [interval, setInterval] = useState<BillingInterval>("monthly");

  return (
    <div className="space-y-8">
      {/* Interval toggle */}
      <div className="flex justify-center">
        <div className="inline-flex items-center rounded-full border border-border/50 bg-sidebar p-1">
          <button
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              interval === "monthly"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setInterval("monthly")}
            type="button"
          >
            Monthly
          </button>
          <button
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              interval === "yearly"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setInterval("yearly")}
            type="button"
          >
            Annual
          </button>
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.free}
          planName="free"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          isPopular
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.pro}
          planName="pro"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.business}
          planName="business"
        />
        <PlanCard
          currentInterval={currentInterval}
          currentPlan={currentPlan}
          currentTier={currentTier}
          gasCreditCaps={gasCreditCaps}
          interval={interval}
          onPlanUpdated={onPlanUpdated}
          plan={PLANS.enterprise}
          planName="enterprise"
        />
      </div>

      {/* Overage callout */}
      <div className="border-l-4 border-yellow-500/50 bg-yellow-500/5 rounded-r-lg p-4">
        <h4 className="text-sm font-medium mb-3">
          When users reach their execution limit
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/50 bg-sidebar p-3">
            <p className="text-sm font-medium">Pay per execution (default)</p>
            <p className="text-xs text-muted-foreground mt-1">
              On paid tiers, overages billed at end of cycle
            </p>
          </div>
          <div className="rounded-lg border border-border/50 bg-sidebar p-3">
            <p className="text-sm font-medium">Bump executions</p>
            <p className="text-xs text-muted-foreground mt-1">
              Select a higher tier from the dropdown
            </p>
          </div>
          <div className="rounded-lg border border-border/50 bg-sidebar p-3">
            <p className="text-sm font-medium">Upgrade their plan</p>
            <p className="text-xs text-muted-foreground mt-1">
              Move to a higher plan for more features
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          On paid tiers, overages are billed at end of cycle. Unpaid overage
          invoices may result in reduced execution limits. Free tier: hard cap,
          must upgrade.
        </p>
      </div>
    </div>
  );
}
