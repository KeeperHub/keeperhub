"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONTACT_EMAIL } from "@/lib/billing/constants";
import type {
  BillingInterval,
  PLANS,
  PlanName,
  TierKey,
} from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { ConfirmPlanChangeDialog } from "../confirm-plan-change-dialog";
import {
  PlanCardBadge,
  PlanCardFeatures,
  PlanCardFooter,
  PriceDisplay,
} from "./plan-card-parts";
import type { GasCreditCapsMap } from "./types";
import {
  cancelSubscription,
  computeDisplayPrice,
  formatPrice,
  getTierPrice,
  isCurrentPlan,
  resolveExecutions,
  startCheckout,
} from "./utils";

export function PlanCard({
  plan,
  planName,
  interval,
  currentPlan,
  currentTier,
  currentInterval,
  gasCreditCaps,
  isPopular = false,
  onPlanUpdated,
}: {
  plan: (typeof PLANS)[PlanName];
  planName: PlanName;
  interval: BillingInterval;
  currentPlan?: PlanName;
  currentTier?: TierKey | null;
  currentInterval?: BillingInterval | null;
  gasCreditCaps?: GasCreditCapsMap;
  isPopular?: boolean;
  onPlanUpdated?: () => Promise<void>;
}): React.ReactElement {
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(
    currentPlan === planName && currentTier
      ? currentTier
      : (plan.tiers[0]?.key ?? null)
  );
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectOpen, setSelectOpen] = useState(false);

  const hasSubscription = currentPlan !== undefined && currentPlan !== "free";

  const isCurrent = isCurrentPlan(
    planName,
    selectedTier,
    interval,
    currentPlan,
    currentTier,
    currentInterval
  );

  const activeTier = plan.tiers.find((t) => t.key === selectedTier);
  const price = computeDisplayPrice(planName, activeTier, interval);

  const annualTotal =
    activeTier && interval === "yearly"
      ? activeTier.monthlyPriceAnnual * 12
      : null;

  async function executeCheckout(): Promise<void> {
    setLoading(true);
    try {
      if (planName === "free") {
        const result = await cancelSubscription();
        if (!result.success) {
          return;
        }
        if (result.periodEnd) {
          const endDate = new Intl.DateTimeFormat("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          }).format(new Date(result.periodEnd));
          toast.success(
            `Your subscription will cancel on ${endDate}. You keep your current plan until then.`
          );
        } else {
          toast.success("Subscription canceled.");
        }
        setConfirmOpen(false);
        await onPlanUpdated?.();
        return;
      }
      const updated = await startCheckout(planName, selectedTier, interval);
      if (updated) {
        setConfirmOpen(false);
        await onPlanUpdated?.();
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubscribe(): void {
    if (planName === "enterprise") {
      window.open(
        `mailto:${CONTACT_EMAIL}?subject=Enterprise%20Plan`,
        "_blank",
        "noopener"
      );
      return;
    }

    if (isCurrent) {
      return;
    }

    if (planName === "free" && hasSubscription) {
      setConfirmOpen(true);
      return;
    }

    if (planName === "free") {
      return;
    }

    if (hasSubscription) {
      setConfirmOpen(true);
      return;
    }

    executeCheckout().catch(() => {
      // error handled inside executeCheckout
    });
  }

  const tierLabel = activeTier
    ? `${activeTier.executions.toLocaleString()} executions`
    : null;

  const currentExecutions = resolveExecutions(currentPlan, currentTier);
  const newExecutions = resolveExecutions(planName, selectedTier);

  return (
    <>
      <ConfirmPlanChangeDialog
        currentExecutions={currentExecutions}
        currentPlanName={currentPlan ?? "free"}
        gasCreditCaps={gasCreditCaps}
        interval={interval}
        newExecutions={newExecutions}
        newPlanName={planName}
        newTier={selectedTier}
        onConfirm={executeCheckout}
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        planName={plan.name}
        price={price ?? 0}
        tierLabel={tierLabel}
      />
      <Card
        className={cn(
          "group relative flex flex-col bg-sidebar border-border/50 transition-transform duration-200 hover:-translate-y-2.5",
          selectOpen && "-translate-y-2.5",
          isPopular &&
            "border-keeperhub-green-dark/50 shadow-keeperhub-green-dark/10 shadow-lg"
        )}
      >
        <PlanCardBadge
          isActive={currentPlan === planName}
          isPopular={isPopular}
        />

        <CardHeader className="pb-2">
          <CardTitle className="text-lg">{plan.name}</CardTitle>
          <p className="text-muted-foreground text-sm">{plan.description}</p>
        </CardHeader>

        <CardContent className="flex-1 space-y-4">
          <PriceDisplay
            annualTotal={annualTotal}
            interval={interval}
            price={price}
          />

          {plan.tiers.length > 0 && (
            <Select
              onOpenChange={setSelectOpen}
              onValueChange={(val) => setSelectedTier(val as TierKey)}
              open={selectOpen}
              value={selectedTier ?? undefined}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select executions" />
              </SelectTrigger>
              <SelectContent>
                {plan.tiers.map((tier) => (
                  <SelectItem key={tier.key} value={tier.key}>
                    {tier.executions.toLocaleString()} executions -{" "}
                    {formatPrice(getTierPrice(tier, interval))}/mo
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <PlanCardFeatures
            activeTier={activeTier}
            gasCreditCentsCap={gasCreditCaps?.[planName]}
            plan={plan}
            planName={planName}
          />
        </CardContent>

        <PlanCardFooter
          currentPlan={currentPlan}
          hasSubscription={hasSubscription}
          isCurrent={isCurrent}
          isPopular={isPopular}
          loading={loading}
          onSubscribe={handleSubscribe}
          plan={plan}
          planName={planName}
        />
      </Card>
    </>
  );
}
