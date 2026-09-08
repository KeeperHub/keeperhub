"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import {
  type BillingInterval,
  PLANS,
  type PlanName,
  type TierKey,
  TRIAL_PLAN_NAME,
} from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import type { PlanTierItem } from "./pricing-table/types";
import { getTierPrice, startCheckout } from "./pricing-table/utils";

const PRO = PLANS.pro;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_PER_YEAR = 12;

// Plan-level Pro perks (execution volume is chosen per-tier below).
const PRO_BENEFITS: readonly string[] = [
  "Full API access",
  `${PRO.features.logRetentionDays}-day log retention`,
  `$${(PRO.features.gasCreditsCents / 100).toFixed(0)} sponsored gas / month`,
  "Email support",
  "Overage billing, no hard cap",
];

type PlanChoice = PlanTierItem & { plan: PlanName };

// What a trialing org can move to from here: every Pro tier, plus the entry
// Business tier as the next step up. The rest of the range is on the plans table.
const PLAN_CHOICES: readonly PlanChoice[] = [
  ...PRO.tiers.map((tier) => ({ ...tier, plan: "pro" as PlanName })),
  ...PLANS.business.tiers
    .slice(0, 1)
    .map((tier) => ({ ...tier, plan: "business" as PlanName })),
];

function choiceId(plan: PlanName, tier: TierKey): string {
  return `${plan}:${tier}`;
}

function annualSaving(choice: PlanChoice): number {
  return (choice.monthlyPrice - choice.monthlyPriceAnnual) * MONTHS_PER_YEAR;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

function daysUntil(endsAt: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(endsAt).getTime() - Date.now()) / DAY_MS)
  );
}

// "11 days left. Converts on August 18, 2026." Falls back to the configured
// trial length when the end date has not been read back from the provider yet.
function trialTimingLine(
  trialEndsAt: string | undefined,
  days: number
): string {
  if (!trialEndsAt) {
    return `${days}-day free trial.`;
  }
  const left = daysUntil(trialEndsAt);
  const converts = dateFormatter.format(new Date(trialEndsAt));
  const unit = left === 1 ? "day" : "days";
  return `${left} ${unit} left. Converts on ${converts}.`;
}

/**
 * Pro trial modal. `tier` is the server-resolved Pro trial tier. Two modes:
 * - Start (default): offer the free trial to an eligible free org.
 * - Update (isUpdate): let a trialing org pick what its trial converts to.
 *   Staying on the trial tier keeps the trial (only the interval changes, $0
 *   now); picking a bigger plan ends the trial and bills immediately.
 * trial:true is sent only while the selection stays on the trial plan/tier.
 */
export function TrialUpsellModal({
  overlayId,
  days,
  tier,
  usage,
  isUpdate = false,
  currentInterval,
  trialEndsAt,
  onNeverShowAgain,
}: {
  overlayId: string;
  days: number;
  tier: TierKey;
  usage?: { executionsUsed: number; executionLimit: number };
  isUpdate?: boolean;
  currentInterval?: BillingInterval;
  trialEndsAt?: string;
  onNeverShowAgain?: () => void;
}): React.ReactElement {
  const { close } = useOverlay();
  const [interval, setInterval] = useState<BillingInterval>(
    currentInterval ?? "monthly"
  );
  const [selectedId, setSelectedId] = useState<string>(
    choiceId(TRIAL_PLAN_NAME, tier)
  );
  const [loading, setLoading] = useState(false);

  const trialTier = PRO.tiers.find((t) => t.key === tier) ?? PRO.tiers[0];
  const selected =
    PLAN_CHOICES.find((c) => choiceId(c.plan, c.key) === selectedId) ??
    PLAN_CHOICES[0];
  // Start mode only ever offers the trial tier; update mode offers the range.
  const active: PlanChoice = isUpdate
    ? selected
    : { ...trialTier, plan: TRIAL_PLAN_NAME };
  const price = getTierPrice(active, interval);

  // Staying on the trial plan/tier keeps the trial alive; anything else ends it
  // and is charged now, so the copy and the checkout intent both branch here.
  const staysOnTrial = active.plan === TRIAL_PLAN_NAME && active.key === tier;
  const noChange =
    isUpdate && staysOnTrial && interval === (currentInterval ?? "monthly");

  // Start mode leads with the reason the offer shows: nearing the free cap.
  const quotaLine =
    usage && usage.executionLimit > 0
      ? `You're reaching your free plan quota: ${usage.executionsUsed.toLocaleString()} of ${usage.executionLimit.toLocaleString()} executions used this month (${Math.round((usage.executionsUsed / usage.executionLimit) * 100)}%).`
      : "You're reaching your free plan quota.";

  async function handleSubmit(): Promise<void> {
    setLoading(true);
    try {
      // trial:true keeps/starts the trial; the server re-checks eligibility.
      const ok = await startCheckout(active.plan, active.key, interval, {
        trial: staysOnTrial,
      });
      // In update mode Stripe updates in place (no redirect); refresh the page
      // to reflect the new tier. Start mode redirects to Checkout instead.
      if (ok) {
        close(overlayId);
        window.location.reload();
      }
    } finally {
      setLoading(false);
    }
  }

  function dismiss(): void {
    close(overlayId);
  }

  function neverAgain(): void {
    onNeverShowAgain?.();
    close(overlayId);
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
        <div className="space-y-1.5">
          <span className="inline-flex items-center gap-2 rounded-full bg-keeperhub-green-dark/10 px-2.5 py-1 font-medium text-keeperhub-green-dark text-xs">
            <Sparkles className="size-3.5" />
            {isUpdate ? "On free trial" : `${days}-day free trial`}
          </span>
          <h2 className="font-bold text-2xl tracking-tight">
            {isUpdate
              ? "Manage your trial plan"
              : `Try Pro free for ${days} days`}
          </h2>
          {isUpdate ? (
            <>
              <p className="font-medium text-foreground text-sm">
                {trialTimingLine(trialEndsAt, days)}
              </p>
              <p className="text-muted-foreground text-sm">
                Choose the plan and billing interval your trial converts to.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-foreground text-sm">{quotaLine}</p>
              <p className="text-muted-foreground text-sm">
                $0 today. Full access to Pro. Cancel anytime before the trial
                ends.
              </p>
            </>
          )}
        </div>
        <button
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          onClick={dismiss}
          type="button"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="grid gap-6 px-6 pb-2 md:grid-cols-2">
        <ul className="space-y-2.5">
          {PRO_BENEFITS.map((benefit) => (
            <li className="flex items-start gap-2 text-sm" key={benefit}>
              <Check className="mt-0.5 size-4 shrink-0 text-keeperhub-green-dark" />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>

        <div className="space-y-3">
          <IntervalToggle
            interval={interval}
            onChange={setInterval}
            saving={annualSaving(active)}
          />

          {isUpdate ? (
            <div className="space-y-2">
              {PLAN_CHOICES.map((choice) => (
                <PlanChoiceRow
                  choice={choice}
                  interval={interval}
                  isCurrent={
                    choice.plan === TRIAL_PLAN_NAME && choice.key === tier
                  }
                  isSelected={choiceId(choice.plan, choice.key) === selectedId}
                  key={choiceId(choice.plan, choice.key)}
                  onSelect={setSelectedId}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-keeperhub-green-dark/60 bg-keeperhub-green-dark/10 px-3 py-2.5 text-sm">
              <span className="font-medium">
                {trialTier.executions.toLocaleString()} executions
              </span>
              <span className="text-muted-foreground">${price}/mo</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-3 border-border/50 border-t px-6 py-4">
        <p className="text-muted-foreground text-xs">
          {getFooterNote({ isUpdate, staysOnTrial, price })}
        </p>
        <Button
          className="w-full rounded-full"
          disabled={loading || noChange}
          onClick={handleSubmit}
        >
          {getButtonLabel({ isUpdate, staysOnTrial, loading, days })}
        </Button>
        <div className="flex items-center justify-between">
          {onNeverShowAgain ? (
            <button
              className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
              onClick={neverAgain}
              type="button"
            >
              Don&apos;t show again
            </button>
          ) : (
            <span />
          )}
          <button
            className="text-muted-foreground text-xs hover:text-foreground"
            onClick={dismiss}
            type="button"
          >
            {isUpdate ? "Cancel" : "Maybe later"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IntervalToggle({
  interval,
  onChange,
  saving,
}: {
  interval: BillingInterval;
  onChange: (value: BillingInterval) => void;
  saving: number;
}): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-sidebar p-1">
      {(["monthly", "yearly"] as const).map((value) => (
        <button
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium text-xs transition-colors",
            interval === value
              ? "bg-keeperhub-green-dark text-white"
              : "text-muted-foreground hover:text-foreground"
          )}
          key={value}
          onClick={() => onChange(value)}
          type="button"
        >
          {value === "monthly" ? "Monthly" : "Annual"}
          {value === "yearly" && saving > 0 && (
            <span
              className={cn(
                "text-[10px]",
                interval === value
                  ? "text-white/80"
                  : "text-keeperhub-green-dark"
              )}
            >
              save ${saving}/yr
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function PlanChoiceRow({
  choice,
  interval,
  isCurrent,
  isSelected,
  onSelect,
}: {
  choice: PlanChoice;
  interval: BillingInterval;
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const label =
    choice.plan === TRIAL_PLAN_NAME
      ? `${choice.executions.toLocaleString()} executions`
      : `${PLANS[choice.plan].name} ${choice.executions.toLocaleString()}`;

  return (
    <button
      className={cn(
        "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
        isSelected
          ? "border-keeperhub-green-dark/60 bg-keeperhub-green-dark/10"
          : "border-border/60 hover:border-border"
      )}
      onClick={() => onSelect(choiceId(choice.plan, choice.key))}
      type="button"
    >
      <span className="flex items-center gap-2 font-medium">
        {label}
        {isCurrent && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase">
            Current
          </span>
        )}
      </span>
      <span className="text-muted-foreground">
        ${getTierPrice(choice, interval)}/mo
      </span>
    </button>
  );
}

function getFooterNote({
  isUpdate,
  staysOnTrial,
  price,
}: {
  isUpdate: boolean;
  staysOnTrial: boolean;
  price: number;
}): string {
  if (!isUpdate) {
    return `After the trial, $${price}/mo. Cancel anytime before it ends and you will not be charged.`;
  }
  if (staysOnTrial) {
    return `No charge now. From the trial end, $${price}/mo.`;
  }
  return `This ends your trial and bills the new plan today, then $${price}/mo.`;
}

function getButtonLabel({
  isUpdate,
  staysOnTrial,
  loading,
  days,
}: {
  isUpdate: boolean;
  staysOnTrial: boolean;
  loading: boolean;
  days: number;
}): string {
  if (!isUpdate) {
    return loading ? "Redirecting..." : `Start ${days}-day free trial`;
  }
  if (loading) {
    return "Updating...";
  }
  return staysOnTrial ? "Update trial plan" : "Upgrade now";
}
