"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  BILLING_API,
  SUPPORT_LABELS,
  SUPPORT_RANK,
} from "@/lib/billing/constants";
import {
  PLANS,
  type PlanLimits,
  type PlanName,
  type TierKey,
} from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import type { GasCreditCapsMap } from "./pricing-table/types";

type ChangeDirection = "upgrade" | "downgrade" | "same";

type FeatureChange = {
  label: string;
  from: string;
  to: string;
  direction: ChangeDirection;
};

type ProrationLineItem = {
  description: string;
  amount: number;
  proration: boolean;
};

type ProrationData = {
  amountDue: number;
  subtotal: number;
  appliedBalance: number;
  currency: string;
  lineItems: ProrationLineItem[];
};

type ConfirmPlanChangeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planName: string;
  tierLabel: string | null;
  interval: string;
  price: number;
  currentPlanName: PlanName;
  currentExecutions: number;
  newPlanName: PlanName;
  newTier: TierKey | null;
  newExecutions: number;
  gasCreditCaps?: GasCreditCapsMap;
  onConfirm: () => Promise<void>;
};

function formatExecutions(count: number): string {
  if (count < 0) {
    return "Unlimited";
  }
  return count.toLocaleString();
}

function formatLogRetention(days: number): string {
  if (days >= 365) {
    return "1 year";
  }
  return `${days} days`;
}

function formatCurrency(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}

function compareNumeric(
  from: number,
  to: number,
  higherIsBetter: boolean
): ChangeDirection {
  if (from === to) {
    return "same";
  }
  const isHigher = to > from;
  return isHigher === higherIsBetter ? "upgrade" : "downgrade";
}

function compareSla(
  currentSla: string | null,
  newSla: string | null
): FeatureChange | null {
  if (currentSla === newSla) {
    return null;
  }
  let direction: ChangeDirection = "same";
  if (currentSla !== null && newSla === null) {
    direction = "downgrade";
  } else if (currentSla === null && newSla !== null) {
    direction = "upgrade";
  } else {
    const currentNum = Number.parseFloat(currentSla ?? "0");
    const newNum = Number.parseFloat(newSla ?? "0");
    direction = newNum > currentNum ? "upgrade" : "downgrade";
  }
  return {
    label: "SLA",
    from: currentSla ?? "None",
    to: newSla ?? "None",
    direction,
  };
}

function compareExecutions(
  currentExecs: number,
  newExecs: number
): FeatureChange | null {
  if (currentExecs === newExecs) {
    return null;
  }
  return {
    label: "Executions",
    from: `${formatExecutions(currentExecs)}/mo`,
    to: `${formatExecutions(newExecs)}/mo`,
    direction: compareNumeric(currentExecs, newExecs, true),
  };
}

function compareSimpleNumeric(
  label: string,
  currentVal: number,
  newVal: number,
  formatter: (v: number) => string
): FeatureChange | null {
  if (currentVal === newVal) {
    return null;
  }
  return {
    label,
    from: formatter(currentVal),
    to: formatter(newVal),
    direction: compareNumeric(currentVal, newVal, true),
  };
}

function compareSupport(
  current: PlanLimits,
  next: PlanLimits
): FeatureChange | null {
  if (current.supportLevel === next.supportLevel) {
    return null;
  }
  const currentRank = SUPPORT_RANK[current.supportLevel] ?? 0;
  const newRank = SUPPORT_RANK[next.supportLevel] ?? 0;
  return {
    label: "Support",
    from: SUPPORT_LABELS[current.supportLevel] ?? current.supportLevel,
    to: SUPPORT_LABELS[next.supportLevel] ?? next.supportLevel,
    direction: compareNumeric(currentRank, newRank, true),
  };
}

function compareApiAccess(
  current: PlanLimits,
  next: PlanLimits
): FeatureChange | null {
  if (current.apiAccess === next.apiAccess) {
    return null;
  }
  return {
    label: "API access",
    from: current.apiAccess === "full" ? "Full" : "Rate-limited",
    to: next.apiAccess === "full" ? "Full" : "Rate-limited",
    direction: next.apiAccess === "full" ? "upgrade" : "downgrade",
  };
}

function buildFeatureChanges(
  currentFeatures: PlanLimits,
  newFeatures: PlanLimits,
  currentExecs: number,
  newExecs: number
): FeatureChange[] {
  const candidates = [
    compareExecutions(currentExecs, newExecs),
    compareSimpleNumeric(
      "Gas credits",
      currentFeatures.gasCreditsCents,
      newFeatures.gasCreditsCents,
      (v) => `$${(v / 100).toFixed(0)}/mo`
    ),
    compareSimpleNumeric(
      "Log retention",
      currentFeatures.logRetentionDays,
      newFeatures.logRetentionDays,
      formatLogRetention
    ),
    compareApiAccess(currentFeatures, newFeatures),
    compareSupport(currentFeatures, newFeatures),
    compareSla(currentFeatures.sla, newFeatures.sla),
  ];
  return candidates.filter((c): c is FeatureChange => c !== null);
}

function ChangeIcon({
  direction,
}: {
  direction: ChangeDirection;
}): React.ReactElement {
  if (direction === "upgrade") {
    return <ArrowUp className="size-3.5 text-keeperhub-green-dark" />;
  }
  if (direction === "downgrade") {
    return <ArrowDown className="size-3.5 text-destructive" />;
  }
  return <Minus className="size-3.5 text-muted-foreground" />;
}

function FeatureChangeRow({
  change,
}: {
  change: FeatureChange;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <div className="flex items-center gap-1.5">
        <ChangeIcon direction={change.direction} />
        <span className="text-muted-foreground">{change.label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground line-through text-xs">
          {change.from}
        </span>
        <span
          className={cn(
            "font-medium",
            change.direction === "upgrade" && "text-keeperhub-green-dark",
            change.direction === "downgrade" && "text-destructive",
            change.direction === "same" && "text-muted-foreground"
          )}
        >
          {change.to}
        </span>
      </div>
    </div>
  );
}

function ProrationTotal({
  amountDue,
  currency,
}: {
  amountDue: number;
  currency: string;
}): React.ReactElement {
  if (amountDue <= 0) {
    return (
      <div className="mt-2 pt-2 border-t border-border/50 flex items-center justify-between">
        <span className="text-sm font-medium">Total due now</span>
        <span className="text-sm font-semibold text-muted-foreground">
          No charge
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t border-border/50 flex items-center justify-between">
      <span className="text-sm font-medium">Total due now</span>
      <span className="text-sm font-semibold text-foreground">
        {formatCurrency(amountDue, currency)}
      </span>
    </div>
  );
}

function ProrationSection({
  proration,
}: {
  proration: ProrationData;
}): React.ReactElement {
  return (
    <div className="rounded-md border border-border/50 bg-sidebar p-3">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Proration breakdown
      </p>
      <div className="space-y-1">
        {proration.lineItems.map((item, index) => (
          <div
            className="flex items-center justify-between text-xs"
            key={`proration-${String(index)}`}
          >
            <span className="text-muted-foreground truncate mr-2">
              {item.description}
            </span>
            <span
              className={cn(
                "font-medium shrink-0",
                item.amount < 0
                  ? "text-keeperhub-green-dark"
                  : "text-foreground"
              )}
            >
              {item.amount < 0 ? "-" : ""}
              {formatCurrency(Math.abs(item.amount), proration.currency)}
            </span>
          </div>
        ))}
        {proration.appliedBalance < 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground truncate mr-2">
              Account credit applied
            </span>
            <span className="font-medium shrink-0 text-keeperhub-green-dark">
              -
              {formatCurrency(
                Math.abs(proration.appliedBalance),
                proration.currency
              )}
            </span>
          </div>
        )}
      </div>
      <ProrationTotal
        amountDue={proration.amountDue}
        currency={proration.currency}
      />
    </div>
  );
}

function ProrationStatus({
  needsProration,
  loading,
  error,
  proration,
}: {
  needsProration: boolean;
  loading: boolean;
  error: boolean;
  proration: ProrationData | null;
}): React.ReactElement | null {
  if (needsProration && loading) {
    return (
      <div className="rounded-md border border-border/50 bg-sidebar p-3 space-y-2">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <div className="pt-2 border-t border-border/50">
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
    );
  }

  if (needsProration && error) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">
          Unable to load pricing details. Please close and try again.
        </p>
      </div>
    );
  }

  if (proration !== null && proration.lineItems.length > 0) {
    return <ProrationSection proration={proration} />;
  }

  return null;
}

function useProrationPreview(
  open: boolean,
  newPlanName: PlanName,
  currentPlanName: PlanName,
  newTier: TierKey | null,
  interval: string
): { proration: ProrationData | null; loading: boolean; error: boolean } {
  const [proration, setProration] = useState<ProrationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) {
      setProration(null);
      setLoading(false);
      setError(false);
      return;
    }

    if (newPlanName === "free" || currentPlanName === "free") {
      return;
    }

    setLoading(true);
    setError(false);
    const controller = new AbortController();

    fetch(BILLING_API.PREVIEW_PRORATION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: newPlanName,
        tier: newTier,
        interval,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          setError(true);
          return;
        }
        const data = (await response.json()) as ProrationData;
        setProration(data);
      })
      .catch((fetchError: unknown) => {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          return;
        }
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [open, newPlanName, currentPlanName, newTier, interval]);

  return { proration, loading, error };
}

export function ConfirmPlanChangeDialog({
  open,
  onOpenChange,
  planName,
  tierLabel,
  interval,
  price,
  currentPlanName,
  currentExecutions,
  newPlanName,
  newTier,
  newExecutions,
  gasCreditCaps,
  onConfirm,
}: ConfirmPlanChangeDialogProps): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const {
    proration,
    loading: prorationLoading,
    error: prorationError,
  } = useProrationPreview(
    open,
    newPlanName,
    currentPlanName,
    newTier,
    interval
  );

  const needsProration = currentPlanName !== "free" && newPlanName !== "free";
  const confirmDisabled =
    loading || (needsProration && (prorationLoading || prorationError));

  async function handleConfirm(
    e: React.MouseEvent<HTMLButtonElement>
  ): Promise<void> {
    e.preventDefault();
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
    }
  }

  const tierDisplay = tierLabel ? ` (${tierLabel})` : "";

  const currentPlanDef = PLANS[currentPlanName];
  const currentTierDisplay =
    currentExecutions > 0 && currentPlanName !== "free"
      ? ` (${formatExecutions(currentExecutions)} executions)`
      : "";

  const currentFeatures: PlanLimits = gasCreditCaps
    ? {
        ...PLANS[currentPlanName].features,
        gasCreditsCents: gasCreditCaps[currentPlanName],
      }
    : PLANS[currentPlanName].features;
  const newFeatures: PlanLimits = gasCreditCaps
    ? {
        ...PLANS[newPlanName].features,
        gasCreditsCents: gasCreditCaps[newPlanName],
      }
    : PLANS[newPlanName].features;
  const changes = buildFeatureChanges(
    currentFeatures,
    newFeatures,
    currentExecutions,
    newExecutions
  );

  const hasDowngrades = changes.some((c) => c.direction === "downgrade");

  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm Plan Change</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-md border border-border/50 bg-sidebar px-4 py-3">
                <div className="flex-1 text-center">
                  <p className="text-xs text-muted-foreground mb-1">From</p>
                  <p className="font-semibold text-foreground">
                    {currentPlanDef.name}
                  </p>
                  {currentTierDisplay && (
                    <p className="text-xs text-muted-foreground">
                      {currentTierDisplay.trim()}
                    </p>
                  )}
                </div>
                <ArrowRight className="size-4 text-muted-foreground shrink-0" />
                <div className="flex-1 text-center">
                  <p className="text-xs text-muted-foreground mb-1">To</p>
                  <p className="font-semibold text-foreground">{planName}</p>
                  {tierDisplay && (
                    <p className="text-xs text-muted-foreground">
                      {tierDisplay.trim()}
                    </p>
                  )}
                </div>
              </div>
              <p className="text-sm">
                <span className="font-semibold text-foreground">
                  ${price}/mo
                </span>
                {interval === "yearly" && (
                  <span className="text-muted-foreground">
                    {" "}
                    billed annually
                  </span>
                )}
                <span className="text-muted-foreground">
                  {" "}
                  -- changes take effect immediately with prorated billing.
                </span>
              </p>

              <ProrationStatus
                error={prorationError}
                loading={prorationLoading}
                needsProration={needsProration}
                proration={proration}
              />

              {changes.length > 0 && (
                <div className="rounded-md border border-border/50 bg-sidebar p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    What changes
                  </p>
                  <div className="space-y-0.5">
                    {changes.map((change) => (
                      <FeatureChangeRow change={change} key={change.label} />
                    ))}
                  </div>
                </div>
              )}

              {hasDowngrades && (
                <p className="text-xs text-destructive">
                  This change reduces some features compared to your current
                  plan.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-keeperhub-green-dark text-white hover:bg-keeperhub-green-dark/90"
            disabled={confirmDisabled}
            onClick={handleConfirm}
          >
            {loading && <Spinner className="mr-2 size-4" />}
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
