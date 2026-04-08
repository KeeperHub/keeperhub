"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BILLING_ALERTS, BILLING_API } from "@/lib/billing/constants";
import { PLANS, type PlanName, type TierKey } from "@/lib/billing/plans";

type OverageCharge = {
  periodStart: string;
  periodEnd: string;
  overageCount: number;
  totalChargeCents: number;
  status: string;
  createdAt: string;
  providerInvoiceId: string | null;
};

type GasCreditsData = {
  totalCents: number;
  usedCents: number;
  remainingCents: number;
};

type SubscriptionData = {
  subscription: {
    plan: string;
    tier: string | null;
    status: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    billingAlert: string | null;
    billingAlertUrl: string | null;
  };
  usage: {
    executionsUsed: number;
    executionLimit: number;
  };
  gasCredits?: GasCreditsData;
  overageCharges: OverageCharge[];
};

type SuggestionNoUpgrade = {
  shouldUpgrade: false;
};

type SuggestionUpgrade = {
  shouldUpgrade: true;
  currentPlan: string;
  currentTier: string | null;
  currentUsage: number;
  currentLimit: number;
  usagePercent: number;
  suggestedPlan: string;
  suggestedTier: string;
  suggestedLimit: number;
  monthlySavings: number;
};

type SuggestionData = SuggestionNoUpgrade | SuggestionUpgrade;

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  trialing: "secondary",
  past_due: "destructive",
  canceled: "destructive",
  unpaid: "destructive",
  paused: "outline",
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

function getRenewalMessage(
  status: string,
  cancelAtPeriodEnd: boolean,
  periodEnd: string | null
): { text: string; className: string } | null {
  if (!periodEnd) {
    return null;
  }

  const formattedDate = dateFormatter.format(new Date(periodEnd));

  if (status === "canceled") {
    return {
      text: `Your subscription was canceled. Access expired on ${formattedDate}.`,
      className: "text-destructive",
    };
  }

  if (status === "paused") {
    return {
      text: "Your subscription is paused. Resume it from the billing portal to restore access.",
      className: "text-yellow-500",
    };
  }

  if (cancelAtPeriodEnd) {
    return {
      text: `Your plan ends on ${formattedDate}. You will not be charged again.`,
      className: "text-muted-foreground",
    };
  }

  if (status === "trialing") {
    return {
      text: `Your trial ends on ${formattedDate}. After that, your subscription will begin.`,
      className: "text-muted-foreground",
    };
  }

  if (status === "past_due") {
    return {
      text: `Payment is past due. Please update your payment method before ${formattedDate} to avoid service interruption.`,
      className: "text-destructive",
    };
  }

  if (status === "active") {
    return {
      text: `Your subscription will auto-renew on ${formattedDate}.`,
      className: "text-muted-foreground",
    };
  }

  return null;
}

function BillingAlertBanner({
  alert,
  alertUrl,
  onManageBilling,
  portalLoading,
}: {
  alert: string;
  alertUrl: string | null;
  onManageBilling: () => void;
  portalLoading: boolean;
}): React.ReactElement | null {
  if (alert === BILLING_ALERTS.PAYMENT_ACTION_REQUIRED) {
    return (
      <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-600 dark:text-yellow-400">
        <p className="font-medium">Action required to complete your payment.</p>
        {alertUrl && (
          <a
            className="mt-1 inline-block underline underline-offset-2"
            href={alertUrl}
            rel="noopener"
            target="_blank"
          >
            Complete payment
          </a>
        )}
      </div>
    );
  }

  if (alert === BILLING_ALERTS.OVERDUE) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <p className="font-medium">
          Your invoice is overdue. Please update your payment method.
        </p>
        <Button
          className="mt-2"
          disabled={portalLoading}
          onClick={onManageBilling}
          size="sm"
          variant="destructive"
        >
          {portalLoading ? "Opening..." : "Manage Billing"}
        </Button>
      </div>
    );
  }

  if (alert === BILLING_ALERTS.PAYMENT_FAILED) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <p className="font-medium">
          Payment failed. Please update your payment method.
        </p>
        <Button
          className="mt-2"
          disabled={portalLoading}
          onClick={onManageBilling}
          size="sm"
          variant="destructive"
        >
          {portalLoading ? "Opening..." : "Manage Billing"}
        </Button>
      </div>
    );
  }

  return null;
}

function UpgradeSuggestionBanner({
  suggestion,
}: {
  suggestion: SuggestionUpgrade;
}): React.ReactElement {
  const savingsFormatted = `$${(suggestion.monthlySavings / 100).toFixed(2)}`;

  function handleScrollToPlans(): void {
    const plansSection = document.getElementById("plans-section");
    if (plansSection) {
      plansSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-600 dark:text-blue-400">
      <p className="font-medium">
        You've used {suggestion.currentUsage.toLocaleString()} of{" "}
        {suggestion.currentLimit.toLocaleString()} executions this month (
        {suggestion.usagePercent}%).
      </p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="text-blue-500 dark:text-blue-300">
          Upgrading to {suggestion.suggestedPlan} ({suggestion.suggestedTier})
          would include {suggestion.suggestedLimit.toLocaleString()} executions
          {suggestion.monthlySavings > 0
            ? ` and save ~${savingsFormatted}/mo in overage fees`
            : ""}
          .
        </p>
        <Button
          className="shrink-0"
          onClick={handleScrollToPlans}
          size="sm"
          variant="outline"
        >
          View Plans
        </Button>
      </div>
    </div>
  );
}

function useBillingData(): {
  data: SubscriptionData | null;
  suggestion: SuggestionData | null;
  loading: boolean;
  error: boolean;
} {
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function fetchSubscription(): Promise<void> {
      try {
        const response = await fetch(BILLING_API.SUBSCRIPTION);
        if (response.ok) {
          const result = (await response.json()) as SubscriptionData;
          setData(result);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    fetchSubscription().catch(() => undefined);
  }, []);

  useEffect(() => {
    async function fetchSuggestion(): Promise<void> {
      try {
        const response = await fetch(BILLING_API.USAGE_SUGGESTION);
        if (response.ok) {
          const result = (await response.json()) as SuggestionData;
          setSuggestion(result);
        }
      } catch {
        // Suggestion is non-critical, silently ignore errors
      }
    }
    fetchSuggestion().catch(() => undefined);
  }, []);

  return { data, suggestion, loading, error };
}

function useBillingPortal(): {
  portalLoading: boolean;
  handleManageBilling: () => Promise<void>;
} {
  const [portalLoading, setPortalLoading] = useState(false);

  async function handleManageBilling(): Promise<void> {
    setPortalLoading(true);
    try {
      const response = await fetch(BILLING_API.PORTAL, {
        method: "POST",
      });
      const result = (await response.json()) as {
        url?: string;
        error?: string;
      };

      if (!response.ok) {
        toast.error(result.error ?? "Failed to open billing portal");
        return;
      }

      if (result.url) {
        window.location.href = result.url;
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  }

  return { portalLoading, handleManageBilling };
}

function BillingStatusSkeleton(): React.ReactElement {
  return (
    <Card className="bg-sidebar">
      <CardHeader>
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-5 w-36 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-72" />
      </CardContent>
    </Card>
  );
}

function ExecutionUsageBar({
  used,
  limit,
  plan,
}: {
  used: number;
  limit: number;
  plan: PlanName;
}): React.ReactElement {
  const isUnlimited = limit === -1;
  const percent = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const isOverLimit = !isUnlimited && used >= limit;
  const isNearLimit = !isUnlimited && percent >= 80;
  const hasOverage = PLANS[plan].overage.enabled;
  const overageRate = PLANS[plan].overage.ratePerThousand;

  function resolveBarColor(): string {
    if (isOverLimit) {
      return hasOverage ? "bg-muted-foreground" : "bg-destructive";
    }
    if (isNearLimit) {
      return "bg-yellow-500";
    }
    return "bg-keeperhub-green";
  }
  const barColor = resolveBarColor();

  const overageCount = isOverLimit ? used - limit : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Monthly executions</span>
        <span className="font-medium">
          {used.toLocaleString()} /{" "}
          {isUnlimited ? "Unlimited" : limit.toLocaleString()}
        </span>
      </div>
      {!(isUnlimited || isOverLimit) && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {!isUnlimited && isOverLimit && (
        <div className="flex h-2 w-full gap-0.5">
          <div className="h-full flex-1 overflow-hidden rounded-l-full bg-muted">
            <div className="h-full w-full rounded-l-full bg-muted-foreground" />
          </div>
          <div
            className="h-full overflow-hidden rounded-r-full bg-muted"
            style={{ width: `${Math.min((overageCount / limit) * 100, 50)}%` }}
          >
            <div className="h-full w-full rounded-r-full bg-destructive/50 transition-all" />
          </div>
        </div>
      )}
      {isOverLimit && hasOverage && (
        <p className="text-xs text-muted-foreground">
          {overageCount.toLocaleString()} overage execution
          {overageCount === 1 ? "" : "s"} at{" "}
          <span className="font-semibold">
            ${(overageRate / 1000).toFixed(4)}/execution
          </span>{" "}
          will be added to your next invoice.
        </p>
      )}
      {isOverLimit && !hasOverage && (
        <p className="text-xs text-destructive">
          You have reached your monthly execution limit. Upgrade your plan to
          continue.
        </p>
      )}
    </div>
  );
}

function GasCreditsBar({
  gasCredits,
}: {
  gasCredits: GasCreditsData;
}): React.ReactElement | null {
  if (gasCredits.totalCents <= 0) {
    return null;
  }

  const percent = Math.min(
    (gasCredits.usedCents / gasCredits.totalCents) * 100,
    100
  );
  const isExhausted = gasCredits.remainingCents <= 0;
  const isNearLimit = percent >= 80;

  function resolveBarColor(): string {
    if (isExhausted) {
      return "bg-destructive";
    }
    if (isNearLimit) {
      return "bg-yellow-500";
    }
    return "bg-keeperhub-green";
  }
  const barColor = resolveBarColor();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Gas sponsorship credits</span>
        <span className="font-medium">
          ${(gasCredits.usedCents / 100).toFixed(2)} / $
          {(gasCredits.totalCents / 100).toFixed(2)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {isExhausted && (
        <p className="text-xs text-muted-foreground">
          Gas credits exhausted. Transactions will use your wallet's ETH for
          gas.
        </p>
      )}
    </div>
  );
}

const OVERAGE_STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  billed: "secondary",
  pending: "outline",
  failed: "destructive",
};

function OverageChargesSection({
  charges,
}: {
  charges: OverageCharge[];
}): React.ReactElement | null {
  const visibleCharges = charges.filter(
    (c) => c.providerInvoiceId === null || c.providerInvoiceId === undefined
  );
  if (visibleCharges.length === 0) {
    return null;
  }

  const formatPeriod = (start: string, end: string): string => {
    const s = new Date(start).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const e = new Date(end).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${s} - ${e}`;
  };

  const pendingTotal = visibleCharges
    .filter((c) => c.status === "pending")
    .reduce((sum, c) => sum + c.totalChargeCents, 0);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">
        Overage charges
      </p>
      <div className="space-y-1.5">
        {visibleCharges.map((charge) => (
          <div
            className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
            key={`${charge.periodStart}-${charge.periodEnd}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {formatPeriod(charge.periodStart, charge.periodEnd)}
              </span>
              <span>{charge.overageCount.toLocaleString()} executions</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-medium">
                ${(charge.totalChargeCents / 100).toFixed(2)}
              </span>
              <Badge
                variant={OVERAGE_STATUS_VARIANT[charge.status] ?? "outline"}
              >
                {charge.status}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      {pendingTotal > 0 && (
        <p className="text-xs text-muted-foreground">
          ${(pendingTotal / 100).toFixed(2)} in overage charges will be added to
          your next invoice.
        </p>
      )}
    </div>
  );
}

function BillingStatusContent({
  sub,
  usage,
  gasCredits,
  overageCharges,
  suggestion,
  portalLoading,
  onManageBilling,
}: {
  sub: SubscriptionData["subscription"] | undefined;
  usage: SubscriptionData["usage"] | undefined;
  gasCredits: GasCreditsData | undefined;
  overageCharges: OverageCharge[];
  suggestion: SuggestionData | null;
  portalLoading: boolean;
  onManageBilling: () => void;
}): React.ReactElement {
  const plan = (sub?.plan ?? "free") as PlanName;
  const planDef = PLANS[plan];
  const tier = sub?.tier as TierKey | null;
  const activeTier = tier ? planDef.tiers.find((t) => t.key === tier) : null;
  const statusVariant = STATUS_VARIANT[sub?.status ?? "active"] ?? "outline";

  const renewalMessage = getRenewalMessage(
    sub?.status ?? "active",
    sub?.cancelAtPeriodEnd ?? false,
    sub?.currentPeriodEnd ?? null
  );

  return (
    <CardContent className="space-y-4">
      {sub?.billingAlert && (
        <BillingAlertBanner
          alert={sub.billingAlert}
          alertUrl={sub.billingAlertUrl ?? null}
          onManageBilling={onManageBilling}
          portalLoading={portalLoading}
        />
      )}

      {suggestion?.shouldUpgrade === true && (
        <UpgradeSuggestionBanner suggestion={suggestion} />
      )}

      <div className="flex items-center gap-3">
        <span className="text-2xl font-bold">{planDef.name}</span>
        {activeTier && (
          <Badge variant="outline">
            {activeTier.executions.toLocaleString()} executions
          </Badge>
        )}
        <Badge variant={statusVariant}>{sub?.status ?? "active"}</Badge>
      </div>

      {usage && (
        <ExecutionUsageBar
          limit={usage.executionLimit}
          plan={plan}
          used={usage.executionsUsed}
        />
      )}

      {gasCredits && <GasCreditsBar gasCredits={gasCredits} />}

      <OverageChargesSection charges={overageCharges} />

      {renewalMessage && (
        <p className={`text-sm ${renewalMessage.className}`}>
          {renewalMessage.text}
        </p>
      )}
    </CardContent>
  );
}

export function BillingStatus(): React.ReactElement {
  const { data, suggestion, loading, error } = useBillingData();
  const { portalLoading, handleManageBilling } = useBillingPortal();

  if (loading) {
    return <BillingStatusSkeleton />;
  }

  if (error && !data) {
    return (
      <Card className="bg-sidebar">
        <CardHeader>
          <CardTitle>Current Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Unable to load billing information. Please try refreshing the page.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sub = data?.subscription;
  const plan = (sub?.plan ?? "free") as PlanName;

  return (
    <Card className="bg-sidebar">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Current Plan</CardTitle>
          {plan !== "free" && (
            <Button
              disabled={portalLoading}
              onClick={handleManageBilling}
              size="sm"
              variant="outline"
            >
              {portalLoading ? "Opening..." : "Manage Billing"}
            </Button>
          )}
        </div>
      </CardHeader>
      <BillingStatusContent
        gasCredits={data?.gasCredits}
        onManageBilling={handleManageBilling}
        overageCharges={data?.overageCharges ?? []}
        portalLoading={portalLoading}
        sub={sub}
        suggestion={suggestion}
        usage={data?.usage}
      />
    </Card>
  );
}
