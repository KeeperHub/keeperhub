"use client";

import { Info, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BILLING_ALERTS, BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  billsOverage,
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import {
  SPONSORSHIP_MAINNET_NAMES,
  SPONSORSHIP_TESTNET_NAMES,
} from "@/lib/web3/sponsorship-chains-meta";
import { isGasSponsorshipEnabled } from "@/lib/web3/sponsorship-feature-flag";
import { GasSponsorshipHistory } from "./gas-sponsorship-history";
import { PaygSection } from "./payg-section";
import { TrialUpsellModal } from "./trial-upsell-modal";

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
    interval: string | null;
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
  trial?: { eligible: boolean; days: number; tier: TierKey };
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
  trialing: "outline",
  past_due: "destructive",
  canceled: "destructive",
  unpaid: "destructive",
  paused: "outline",
};

// Human-friendly labels for the raw subscription status.
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trialing: "Free trial",
  past_due: "Past due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  paused: "Paused",
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
      text: `Access stays active until ${formattedDate}.`,
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

// Compact "Start free trial" trigger shown beside the plan title for eligible
// free orgs. Opens the trial offer modal (plan options + benefits).
function StartTrialButton({
  days,
  tier,
  usage,
}: {
  days: number;
  tier: TierKey;
  usage: SubscriptionData["usage"] | undefined;
}): React.ReactElement {
  const { open } = useOverlay();
  return (
    <button
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-keeperhub-green-dark/30 bg-keeperhub-green-dark/10 px-3 py-1.5 font-medium text-keeperhub-green-dark text-xs transition-colors hover:bg-keeperhub-green-dark/20"
      onClick={() =>
        open(TrialUpsellModal, { days, tier, usage }, { size: "2xl" })
      }
      type="button"
    >
      <Sparkles className="size-3.5" />
      Start free trial
    </button>
  );
}

// Shown in the Current Plan header while trialing. Opens the trial modal in
// update mode so the user can change the interval without losing the trial.
function ManageTrialButton({
  currentTier,
  currentInterval,
  days,
}: {
  currentTier: TierKey;
  currentInterval: BillingInterval;
  days: number;
}): React.ReactElement {
  const { open } = useOverlay();
  return (
    <Button
      onClick={() =>
        open(
          TrialUpsellModal,
          { days, tier: currentTier, isUpdate: true, currentInterval },
          { size: "2xl" }
        )
      }
      size="sm"
      variant="outline"
    >
      Manage trial
    </Button>
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
  paygEnabled,
}: {
  used: number;
  limit: number;
  plan: PlanName;
  paygEnabled: boolean;
}): React.ReactElement {
  const isUnlimited = limit === -1;
  const percent = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const isOverLimit = !isUnlimited && used >= limit;
  const isNearLimit = !isUnlimited && percent >= 80;
  const hasOverage = PLANS[plan].overage.enabled;
  const overageRate = PLANS[plan].overage.ratePerThousand;
  // Free orgs with PAYG on keep running past the limit (charged per execution),
  // so treat it like overage: no hard block, no destructive styling.
  const overflowCovered = hasOverage || paygEnabled;

  function resolveBarColor(): string {
    if (isOverLimit && !overflowCovered) {
      return "bg-destructive";
    }
    if (isNearLimit && !isOverLimit) {
      return "bg-yellow-500";
    }
    return "bg-keeperhub-green-dark";
  }
  const barColor = resolveBarColor();

  const overageCount = isOverLimit ? used - limit : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1 text-muted-foreground">
          Monthly executions
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="How monthly executions are counted"
                className="inline-flex cursor-help items-center text-muted-foreground transition-colors hover:text-foreground"
                type="button"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                Counts billable executions for the current calendar month (since
                the 1st, UTC) and resets on the 1st. This is your plan quota
                usage, so it differs from the Analytics page, which counts all
                executions over the time range you select there (for example,
                the last 30 days).
              </p>
            </TooltipContent>
          </Tooltip>
        </span>
        <span className="font-medium">
          {used.toLocaleString()} /{" "}
          {isUnlimited ? "Unlimited" : limit.toLocaleString()}
        </span>
      </div>
      {!(isUnlimited || isOverLimit) && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-keeperhub-green-dark/15">
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {!isUnlimited && isOverLimit && (
        <div className="flex h-2 w-full gap-0.5">
          <div className="h-full flex-1 overflow-hidden rounded-l-full bg-keeperhub-green-dark/15">
            <div className="h-full w-full rounded-l-full bg-keeperhub-green-dark" />
          </div>
          <div
            className="h-full overflow-hidden rounded-r-full bg-keeperhub-green-dark/15"
            style={{ width: `${Math.min((overageCount / limit) * 100, 50)}%` }}
          >
            <div className="h-full w-full rounded-r-full bg-yellow-500 transition-all" />
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
      {isOverLimit && !hasOverage && paygEnabled && (
        <p className="text-muted-foreground text-xs">
          Beyond your free limit, each execution is charged via pay-as-you-go.
        </p>
      )}
      {isOverLimit && !hasOverage && !paygEnabled && (
        <p className="text-destructive text-xs">
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
    return "bg-keeperhub-green-dark";
  }
  const barColor = resolveBarColor();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1 text-muted-foreground">
          Gas sponsorship credits
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Supported networks"
                className="inline-flex cursor-help items-center text-muted-foreground transition-colors hover:text-foreground"
                type="button"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="space-y-1.5">
                <p className="font-medium">Supported networks</p>
                <p>
                  <span className="font-medium">Mainnets:</span>{" "}
                  {SPONSORSHIP_MAINNET_NAMES.join(", ")}
                </p>
                <p>
                  <span className="font-medium">Testnets:</span>{" "}
                  {SPONSORSHIP_TESTNET_NAMES.join(", ")}
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        </span>
        <span className="font-medium">
          ${(gasCredits.usedCents / 100).toFixed(2)} / $
          {(gasCredits.totalCents / 100).toFixed(2)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-keeperhub-green-dark/15">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <GasSponsorshipHistory />
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
  trial,
  portalLoading,
  onManageBilling,
}: {
  sub: SubscriptionData["subscription"] | undefined;
  usage: SubscriptionData["usage"] | undefined;
  gasCredits: GasCreditsData | undefined;
  overageCharges: OverageCharge[];
  suggestion: SuggestionData | null;
  trial: SubscriptionData["trial"] | undefined;
  portalLoading: boolean;
  onManageBilling: () => void;
}): React.ReactElement {
  const plan = parsePlanName(sub?.plan);
  const planDef = PLANS[plan];

  // Free orgs can enable pay-as-you-go to keep running past the free limit, so
  // the over-limit message must not tell them to upgrade when PAYG is on.
  const [paygEnabled, setPaygEnabled] = useState(false);
  useEffect(() => {
    if (plan !== "free") {
      setPaygEnabled(false);
      return;
    }
    let cancelled = false;
    async function loadPaygEnabled(): Promise<void> {
      const res = await fetch(BILLING_API.PAYG);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { enabled?: boolean };
      if (!cancelled) {
        setPaygEnabled(Boolean(data.enabled));
      }
    }
    loadPaygEnabled().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [plan]);

  const status = sub?.status ?? "active";
  const statusVariant = STATUS_VARIANT[status] ?? "outline";
  const isTrialing = status === "trialing";
  const isCanceling =
    (sub?.cancelAtPeriodEnd ?? false) && status !== "canceled";

  // A cancel-at-period-end sub collapses to a single "cancelled" chip (the
  // decision is already made; access just rides out the period).
  let statusLabel = STATUS_LABEL[status] ?? status;
  let badgeClass: string | undefined;
  if (isCanceling) {
    statusLabel = isTrialing ? "Trial cancelled" : "Cancelled";
    badgeClass =
      "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
  } else if (isTrialing) {
    badgeClass =
      "border-keeperhub-green-dark/40 bg-keeperhub-green-dark/10 text-keeperhub-green-dark";
  }
  const badgeVariant = isCanceling ? "outline" : statusVariant;
  // Only offer the trial to engaged free orgs (>= 50% of the free cap used),
  // matching the global upsell modal's threshold.
  const usedRatio =
    usage && usage.executionLimit > 0
      ? usage.executionsUsed / usage.executionLimit
      : 0;
  const canStartTrial =
    plan === "free" && trial?.eligible === true && usedRatio >= 0.5;

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

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-2xl font-bold">{planDef.name}</span>
          <Badge className={badgeClass} variant={badgeVariant}>
            {statusLabel}
          </Badge>
          {renewalMessage && (
            <p className={`text-sm ${renewalMessage.className}`}>
              {renewalMessage.text}
            </p>
          )}
        </div>
        {canStartTrial && trial && (
          <StartTrialButton days={trial.days} tier={trial.tier} usage={usage} />
        )}
      </div>

      {usage && (
        <ExecutionUsageBar
          limit={usage.executionLimit}
          paygEnabled={paygEnabled}
          plan={plan}
          used={usage.executionsUsed}
        />
      )}

      {gasCredits && isGasSponsorshipEnabled() && (
        <GasCreditsBar gasCredits={gasCredits} />
      )}

      <OverageChargesSection charges={overageCharges} />

      {/* Overage plans never had pay-as-you-go, so they have no charges to show.
          The rest keep the section, which self-hides when there is nothing. */}
      {!billsOverage(plan) && <PaygSection plan={plan} />}
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
  const plan = parsePlanName(sub?.plan);
  const trialTier = parseTierKey(sub?.tier);
  const trialInterval: BillingInterval =
    sub?.interval === "yearly" ? "yearly" : "monthly";
  const canManageTrial = sub?.status === "trialing" && trialTier !== null;

  return (
    <Card className="bg-sidebar">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Current Plan</CardTitle>
          <div className="flex items-center gap-2">
            {canManageTrial && trialTier && (
              <ManageTrialButton
                currentInterval={trialInterval}
                currentTier={trialTier}
                days={data?.trial?.days ?? 14}
              />
            )}
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
        </div>
      </CardHeader>
      <BillingStatusContent
        gasCredits={data?.gasCredits}
        onManageBilling={handleManageBilling}
        overageCharges={data?.overageCharges ?? []}
        portalLoading={portalLoading}
        sub={sub}
        suggestion={suggestion}
        trial={data?.trial}
        usage={data?.usage}
      />
    </Card>
  );
}
