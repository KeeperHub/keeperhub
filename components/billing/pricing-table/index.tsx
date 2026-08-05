"use client";

import {
  type BillingInterval as PkgBillingInterval,
  type ComparisonCell as PkgComparisonCell,
  type ComparisonColumn as PkgComparisonColumn,
  type ComparisonRow as PkgComparisonRow,
  type PricingCard as PkgPricingCard,
  PricingCards,
  PricingComparisonTable,
  type PricingCtaContext,
} from "keeperhub-pricing-ui";
import "keeperhub-pricing-ui/styles.css";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BILLING_API } from "@/lib/billing/constants";
import {
  type BillingInterval,
  PLANS,
  type PlanName,
  type TierKey,
} from "@/lib/billing/plans";
import {
  SPONSORSHIP_MAINNET_NAMES,
  SPONSORSHIP_TESTNET_NAMES,
} from "@/lib/web3/sponsorship-chains-meta";
import { ConfirmPlanChangeDialog } from "../confirm-plan-change-dialog";
import type { GasCreditCapsMap, PricingTableProps, TrialInfo } from "./types";
import {
  cancelSubscription,
  computeDisplayPrice,
  getButtonLabel,
  getTierPrice,
  isCurrentPlan,
  isTrialSelection,
  resolveExecutions,
  startCheckout,
} from "./utils";

type TieredPlanName = "pro" | "business";

const PLAN_ORDER: readonly PlanName[] = [
  "free",
  "pro",
  "business",
  "enterprise",
];

const MONTHS_PER_YEAR = 12;

type ConfirmTarget = {
  planName: PlanName;
  tierKey: TierKey | null;
  appInterval: BillingInterval;
  // Opt-in to the free trial. Set only for the trial offer (Pro at the resolved
  // trial tier); every other selection pays now. The server re-checks it.
  trial: boolean;
};

type CheckoutHandlers = {
  currentPlan: PlanName;
  currentTier: TierKey | null | undefined;
  currentInterval: BillingInterval | null | undefined;
  hasSubscription: boolean;
  onPlanUpdated?: () => Promise<void>;
  setLoadingCardId: (id: PlanName | null) => void;
  setConfirmTarget: (target: ConfirmTarget) => void;
  setConfirmOpen: (open: boolean) => void;
};

function appIntervalToPkg(value: BillingInterval): PkgBillingInterval {
  return value === "yearly" ? "annual" : "monthly";
}

function pkgIntervalToApp(value: PkgBillingInterval): BillingInterval {
  return value === "annual" ? "yearly" : "monthly";
}

function formatFreePrice(paygPriceUsdc: string | null): string {
  if (!paygPriceUsdc) {
    return "$0.01";
  }
  return `$${Number(paygPriceUsdc).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })}`;
}

function formatCardGas(capCents: number): string {
  return `$${(capCents / 100).toFixed(0)}`;
}

// -- Checkout orchestration (mirrors the previous per-card PlanCard logic) --

async function executeCheckout(
  target: ConfirmTarget,
  handlers: Pick<
    CheckoutHandlers,
    "onPlanUpdated" | "setLoadingCardId" | "setConfirmOpen"
  >
): Promise<void> {
  const { planName, tierKey, appInterval, trial } = target;
  handlers.setLoadingCardId(planName);
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
      handlers.setConfirmOpen(false);
      await handlers.onPlanUpdated?.();
      return;
    }
    const updated = await startCheckout(planName, tierKey, appInterval, {
      trial,
    });
    if (updated) {
      handlers.setConfirmOpen(false);
      await handlers.onPlanUpdated?.();
    }
  } catch {
    toast.error("Something went wrong. Please try again.");
  } finally {
    handlers.setLoadingCardId(null);
  }
}

function handleSubscribe(
  target: ConfirmTarget,
  handlers: CheckoutHandlers
): void {
  const { planName, tierKey, appInterval } = target;
  if (planName === "enterprise") {
    window.open(
      "mailto:human@keeperhub.com?subject=Enterprise%20Plan",
      "_blank",
      "noopener"
    );
    return;
  }
  const isCurrent = isCurrentPlan(
    planName,
    tierKey,
    appInterval,
    handlers.currentPlan,
    handlers.currentTier,
    handlers.currentInterval
  );
  if (isCurrent) {
    return;
  }
  if (planName === "free" && handlers.hasSubscription) {
    handlers.setConfirmTarget(target);
    handlers.setConfirmOpen(true);
    return;
  }
  if (planName === "free") {
    return;
  }
  if (handlers.hasSubscription) {
    handlers.setConfirmTarget(target);
    handlers.setConfirmOpen(true);
    return;
  }
  executeCheckout(target, handlers).catch(() => {
    // handled inside executeCheckout
  });
}

// -- Card builders --

function buildFreeCard(params: {
  currentPlan: PlanName;
  freePriceDisplay: string;
  gasCreditCaps?: GasCreditCapsMap;
  hasSubscription: boolean;
  loading: boolean;
  trialOffered: boolean;
  onSelect: (context: PricingCtaContext) => void;
}): PkgPricingCard {
  const {
    currentPlan,
    freePriceDisplay,
    gasCreditCaps,
    hasSubscription,
    loading,
    trialOffered,
    onSelect,
  } = params;
  const plan = PLANS.free;
  const isCurrent = currentPlan === "free";
  const capCents = gasCreditCaps?.free ?? plan.features.gasCreditsCents;

  return {
    id: "free",
    name: "Pay per execution",
    // While the trial is on offer the green border marks it, not the plan the
    // org is already on. The CURRENT badge still says where they stand.
    highlight: isCurrent && !trialOffered,
    badgeText: isCurrent ? "CURRENT" : undefined,
    metricsLabel: "Includes per month",
    fixedPrice: freePriceDisplay,
    fixedSubtitle: "Free to start. No commitments.",
    fixedMetrics: [
      {
        label: "Executions",
        value: plan.features.maxExecutionsPerMonth.toLocaleString(),
      },
      { label: "Gas credits", value: formatCardGas(capCents) },
    ],
    cta: {
      label: getButtonLabel("free", isCurrent, loading, hasSubscription),
      onClick: onSelect,
      // Downgrading is not something to lead with: on a paid plan this button
      // cancels, so it stays quiet while the plans being sold are filled.
      variant: hasSubscription ? "secondary" : "primary",
      disabled: isCurrent || loading,
    },
    footnote: `${plan.features.maxExecutionsPerMonth.toLocaleString()} free / mo, then pay-as-you-go`,
  };
}

function buildTieredCard(params: {
  planName: TieredPlanName;
  interval: BillingInterval;
  selectedTier: TierKey | null;
  currentPlan: PlanName;
  currentTier: TierKey | null | undefined;
  currentInterval: BillingInterval | null | undefined;
  gasCreditCaps?: GasCreditCapsMap;
  hasSubscription: boolean;
  loading: boolean;
  trialDays: number | null;
  onSelect: (context: PricingCtaContext) => void;
}): PkgPricingCard {
  const {
    planName,
    interval,
    selectedTier,
    currentPlan,
    currentTier,
    currentInterval,
    gasCreditCaps,
    hasSubscription,
    loading,
    trialDays,
    onSelect,
  } = params;
  const plan = PLANS[planName];
  const isCurrent = isCurrentPlan(
    planName,
    selectedTier,
    interval,
    currentPlan,
    currentTier,
    currentInterval
  );
  const capCents = gasCreditCaps?.[planName] ?? plan.features.gasCreditsCents;
  const gas = formatCardGas(capCents);
  const isHighlighted = currentPlan === planName || trialDays !== null;
  const activeTier = plan.tiers.find((tier) => tier.key === selectedTier);
  const trialPrice = activeTier ? getTierPrice(activeTier, interval) : null;

  return {
    id: planName,
    name: plan.name,
    highlight: isHighlighted,
    badgeText: buildTieredBadgeText(currentPlan === planName, trialDays),
    metricsLabel: "Includes per month",
    tiers: plan.tiers.map((tier) => ({
      key: tier.key,
      executions: tier.executions.toLocaleString(),
      monthlyPrice: tier.monthlyPrice,
      annualPrice: tier.monthlyPriceAnnual,
      gas,
    })),
    tierKey: selectedTier ?? undefined,
    cta: {
      label: getButtonLabel(
        planName,
        isCurrent,
        loading,
        hasSubscription,
        trialDays
      ),
      onClick: onSelect,
      variant: trialDays === null ? "secondary" : "primary",
      disabled: isCurrent || loading,
    },
    footnote: buildTieredFootnote(plan, trialDays, trialPrice, interval),
  };
}

function buildTieredBadgeText(
  isCurrentPlanCard: boolean,
  trialDays: number | null
): string | undefined {
  if (isCurrentPlanCard) {
    return "CURRENT";
  }
  return trialDays === null ? undefined : `${trialDays}-DAY FREE TRIAL`;
}

function buildTieredFootnote(
  plan: (typeof PLANS)[TieredPlanName],
  trialDays: number | null,
  trialPrice: number | null,
  interval: BillingInterval
): string | undefined {
  // Keep this to one line: the footnote pill wraps and unbalances the card.
  // An annual trial converts to a year charged up front, so quote that total
  // rather than the per-month rate the headline shows.
  if (trialDays !== null && trialPrice !== null) {
    return interval === "yearly"
      ? `$0 today, then $${(trialPrice * MONTHS_PER_YEAR).toLocaleString()}/yr`
      : `$0 today, then $${trialPrice}/mo`;
  }
  return plan.overage.enabled
    ? `$${plan.overage.ratePerThousand}/1K additional executions`
    : undefined;
}

function buildEnterpriseCard(params: {
  currentPlan: PlanName;
  currentTier: TierKey | null | undefined;
  currentInterval: BillingInterval | null | undefined;
  interval: BillingInterval;
  hasSubscription: boolean;
  loading: boolean;
  onSelect: (context: PricingCtaContext) => void;
}): PkgPricingCard {
  const {
    currentPlan,
    currentTier,
    currentInterval,
    interval,
    hasSubscription,
    loading,
    onSelect,
  } = params;
  const plan = PLANS.enterprise;
  const isCurrent = isCurrentPlan(
    "enterprise",
    null,
    interval,
    currentPlan,
    currentTier,
    currentInterval
  );
  const isHighlighted = currentPlan === "enterprise";

  return {
    id: "enterprise",
    name: plan.name,
    highlight: isHighlighted,
    badgeText: isHighlighted ? "CURRENT" : undefined,
    metricsLabel: "Includes per month",
    fixedPrice: "Custom",
    fixedSubtitle: "Custom everything",
    fixedMetrics: [
      { label: "Executions", value: "Custom" },
      { label: "Gas credits", value: "Custom" },
    ],
    cta: {
      label: getButtonLabel("enterprise", isCurrent, loading, hasSubscription),
      onClick: onSelect,
      variant: "secondary",
      disabled: isCurrent || loading,
    },
    footnote: "Custom overage terms",
  };
}

function buildCards(params: {
  currentPlan: PlanName;
  currentTier: TierKey | null | undefined;
  currentInterval: BillingInterval | null | undefined;
  interval: BillingInterval;
  selectedTierByCard: Record<TieredPlanName, TierKey | null>;
  gasCreditCaps: GasCreditCapsMap | undefined;
  hasSubscription: boolean;
  loadingCardId: PlanName | null;
  freePriceDisplay: string;
  proTrialDays: number | null;
  onSelect: (planName: PlanName, context: PricingCtaContext) => void;
}): PkgPricingCard[] {
  const {
    currentPlan,
    currentTier,
    currentInterval,
    interval,
    selectedTierByCard,
    gasCreditCaps,
    hasSubscription,
    loadingCardId,
    freePriceDisplay,
    proTrialDays,
    onSelect,
  } = params;

  return [
    buildFreeCard({
      currentPlan,
      freePriceDisplay,
      gasCreditCaps,
      hasSubscription,
      loading: loadingCardId === "free",
      trialOffered: proTrialDays !== null,
      onSelect: (context) => onSelect("free", context),
    }),
    buildTieredCard({
      planName: "pro",
      interval,
      selectedTier: selectedTierByCard.pro,
      currentPlan,
      currentTier,
      currentInterval,
      gasCreditCaps,
      hasSubscription,
      loading: loadingCardId === "pro",
      trialDays: proTrialDays,
      onSelect: (context) => onSelect("pro", context),
    }),
    buildTieredCard({
      planName: "business",
      interval,
      selectedTier: selectedTierByCard.business,
      currentPlan,
      currentTier,
      currentInterval,
      gasCreditCaps,
      hasSubscription,
      loading: loadingCardId === "business",
      trialDays: null,
      onSelect: (context) => onSelect("business", context),
    }),
    buildEnterpriseCard({
      currentPlan,
      currentTier,
      currentInterval,
      interval,
      hasSubscription,
      loading: loadingCardId === "enterprise",
      onSelect: (context) => onSelect("enterprise", context),
    }),
  ];
}

// -- Comparison table --

const EXECUTIONS_INCLUDED: Record<PlanName, number> = {
  free: PLANS.free.features.maxExecutionsPerMonth,
  pro: PLANS.pro.tiers[0]?.executions ?? 0,
  business: PLANS.business.tiers[0]?.executions ?? 0,
  enterprise: PLANS.enterprise.features.maxExecutionsPerMonth,
};

const PER_EXECUTION_HINT =
  "Cost per execution once a plan's monthly limit is reached. Free uses pay-as-you-go, charged in USDC from your organization wallet; paid plans bill overage on the next invoice.";

const SPONSORED_GAS_HINT = `Sponsored via Turnkey Gas Station. Mainnets: ${SPONSORSHIP_MAINNET_NAMES.join(
  ", "
)}. Testnets: ${SPONSORSHIP_TESTNET_NAMES.join(
  ", "
)}. Monthly cap of sponsored gas credits in USD; transactions on other chains fall back to your wallet's native balance for gas.`;

const STATIC_COMPARISON_ROWS: readonly PkgComparisonRow[] = [
  {
    label: "Chains",
    cells: {
      free: "All EVM + Solana",
      pro: "All EVM + Solana",
      business: "All EVM + Solana",
      enterprise: "All EVM + Solana",
    },
  },
  {
    label: "Triggers",
    cells: {
      free: "Standard",
      pro: "Advanced",
      business: "Advanced + Custom",
      enterprise: "Custom",
    },
  },
  {
    label: "API",
    cells: {
      free: "Rate-limited",
      pro: "Full",
      business: "Full",
      enterprise: "Full",
    },
  },
  {
    label: "Logs",
    cells: {
      free: "7 days",
      pro: "30 days",
      business: "90 days",
      enterprise: "Custom",
    },
  },
  {
    label: "Support",
    cells: {
      free: "Community",
      pro: "Email",
      business: "Dedicated",
      enterprise: "Dedicated (1h)",
    },
  },
  {
    label: "SLA",
    cells: {
      free: "—",
      pro: "—",
      business: "99.9%",
      enterprise: "99.999%",
    },
  },
  {
    label: "Builder",
    cells: {
      free: "Visual + AI",
      pro: "Visual + AI",
      business: "Visual + AI",
      enterprise: "Visual + AI",
    },
  },
  {
    label: "MCP Server",
    cells: {
      free: "Included",
      pro: "Included",
      business: "Included",
      enterprise: "Included",
    },
  },
  {
    label: "Ops team",
    cells: {
      free: "—",
      pro: "—",
      business: "—",
      enterprise: "Dedicated",
    },
  },
];

function formatExecutions(count: number): string {
  return count === -1 ? "Unlimited" : count.toLocaleString();
}

function formatPerExecution(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatGasCreditCap(planName: PlanName, capCents: number): string {
  if (planName === "enterprise") {
    return "Custom";
  }
  return `$${(capCents / 100).toFixed(0)}/mo`;
}

/** Green "+delta" cell shown when a plan value beats the current plan. */
function gainCell(
  value: string,
  currentValue: number,
  planValue: number,
  format: (delta: number) => string
): PkgComparisonCell {
  if (planValue === -1 || currentValue === -1 || planValue <= currentValue) {
    return value;
  }
  return { value, gain: `+${format(planValue - currentValue)}` };
}

function buildExecutionsRow(currentPlan: PlanName): PkgComparisonRow {
  const currentIncluded = EXECUTIONS_INCLUDED[currentPlan];
  const execFormat = (delta: number): string => delta.toLocaleString();
  const cell = (planName: PlanName): PkgComparisonCell =>
    gainCell(
      formatExecutions(EXECUTIONS_INCLUDED[planName]),
      currentIncluded,
      EXECUTIONS_INCLUDED[planName],
      execFormat
    );
  return {
    label: "Executions / month",
    cells: {
      free: cell("free"),
      pro: cell("pro"),
      business: cell("business"),
      enterprise: formatExecutions(EXECUTIONS_INCLUDED.enterprise),
    },
  };
}

function buildPerExecutionRow(paygPriceUsdc: string | null): PkgComparisonRow {
  const freeCell = paygPriceUsdc
    ? `$${Number(paygPriceUsdc).toLocaleString(undefined, {
        maximumFractionDigits: 6,
      })}`
    : "$0.01";
  return {
    label: "Per extra execution",
    hint: PER_EXECUTION_HINT,
    cells: {
      free: freeCell,
      pro: formatPerExecution(PLANS.pro.overage.ratePerThousand / 1000),
      business: formatPerExecution(
        PLANS.business.overage.ratePerThousand / 1000
      ),
      enterprise: "Custom",
    },
  };
}

function buildSponsoredGasRow(
  currentPlan: PlanName,
  gasCreditCaps?: GasCreditCapsMap
): PkgComparisonRow {
  const resolveCents = (planName: PlanName): number =>
    gasCreditCaps?.[planName] ?? PLANS[planName].features.gasCreditsCents;
  const gasFormat = (delta: number): string =>
    `$${(delta / 100).toFixed(0)}/mo`;
  const cell = (planName: PlanName): PkgComparisonCell =>
    gainCell(
      formatGasCreditCap(planName, resolveCents(planName)),
      resolveCents(currentPlan),
      resolveCents(planName),
      gasFormat
    );
  return {
    label: "Sponsored gas",
    hint: SPONSORED_GAS_HINT,
    cells: {
      free: cell("free"),
      pro: cell("pro"),
      business: cell("business"),
      enterprise: formatGasCreditCap("enterprise", resolveCents("enterprise")),
    },
  };
}

function buildComparisonRows(
  currentPlan: PlanName,
  gasCreditCaps: GasCreditCapsMap | undefined,
  paygPriceUsdc: string | null
): PkgComparisonRow[] {
  return [
    buildExecutionsRow(currentPlan),
    buildPerExecutionRow(paygPriceUsdc),
    ...STATIC_COMPARISON_ROWS.slice(0, 2),
    buildSponsoredGasRow(currentPlan, gasCreditCaps),
    ...STATIC_COMPARISON_ROWS.slice(2),
  ];
}

function buildComparisonColumns(): PkgComparisonColumn[] {
  return PLAN_ORDER.map((planName) => ({
    key: planName,
    label: planName === "free" ? "Pay per execution" : PLANS[planName].name,
  }));
}

// -- Confirm dialog derived data --

type DialogData = ConfirmTarget & {
  price: number;
  tierLabel: string | null;
  currentExecutions: number;
  newExecutions: number;
};

function buildDialogData(
  target: ConfirmTarget | null,
  currentPlan: PlanName,
  currentTier: TierKey | null | undefined
): DialogData {
  const resolved: ConfirmTarget = target ?? {
    planName: "free",
    tierKey: null,
    appInterval: "monthly",
    trial: false,
  };
  const activeTier = PLANS[resolved.planName].tiers.find(
    (tier) => tier.key === resolved.tierKey
  );
  return {
    planName: resolved.planName,
    tierKey: resolved.tierKey,
    appInterval: resolved.appInterval,
    trial: resolved.trial,
    price:
      computeDisplayPrice(
        resolved.planName,
        activeTier,
        resolved.appInterval
      ) ?? 0,
    tierLabel: activeTier
      ? `${activeTier.executions.toLocaleString()} executions`
      : null,
    currentExecutions: resolveExecutions(currentPlan, currentTier),
    newExecutions: resolveExecutions(resolved.planName, resolved.tierKey),
  };
}

// The trial tier the Pro card opens on when the offer is live, so the trial is
// the default selection rather than something the user has to find.
function resolveDefaultProTier(
  currentPlan: PlanName,
  currentTier: TierKey | null | undefined,
  trial: TrialInfo | undefined
): TierKey | null {
  if (currentPlan === "pro" && currentTier) {
    return currentTier;
  }
  if (trial?.eligible === true) {
    return trial.tier;
  }
  return PLANS.pro.tiers[0]?.key ?? null;
}

export function PricingTable({
  currentPlan = "free",
  currentTier,
  currentInterval,
  gasCreditCaps,
  trial,
  onPlanUpdated,
}: PricingTableProps): React.ReactElement {
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [selectedTierByCard, setSelectedTierByCard] = useState<
    Record<TieredPlanName, TierKey | null>
  >({
    pro: resolveDefaultProTier(currentPlan, currentTier, trial),
    business:
      currentPlan === "business" && currentTier
        ? currentTier
        : (PLANS.business.tiers[0]?.key ?? null),
  });
  const [loadingCardId, setLoadingCardId] = useState<PlanName | null>(null);
  const [paygPriceUsdc, setPaygPriceUsdc] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    async function loadPrice(): Promise<void> {
      const res = await fetch(BILLING_API.PAYG);
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { priceUsdc?: string };
      if (!cancelled && data.priceUsdc && Number(data.priceUsdc) > 0) {
        setPaygPriceUsdc(data.priceUsdc);
      }
    }
    loadPrice().catch(() => {
      // PAYG price is optional context for pricing display; ignore load failures.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasSubscription = currentPlan !== "free";
  const handlers: CheckoutHandlers = {
    currentPlan,
    currentTier,
    currentInterval,
    hasSubscription,
    onPlanUpdated,
    setLoadingCardId,
    setConfirmTarget,
    setConfirmOpen,
  };

  function onCardCta(planName: PlanName, context: PricingCtaContext): void {
    const tierKey = (context.tierKey as TierKey | undefined) ?? null;
    handleSubscribe(
      {
        planName,
        tierKey,
        appInterval: pkgIntervalToApp(context.interval),
        trial: isTrialSelection(trial, planName, tierKey),
      },
      handlers
    );
  }

  function onCardTierChange(cardId: string, tierKey: string): void {
    if (cardId === "pro" || cardId === "business") {
      setSelectedTierByCard((prev) => ({
        ...prev,
        [cardId]: tierKey as TierKey,
      }));
    }
  }

  const freePriceDisplay = formatFreePrice(paygPriceUsdc);
  // Only the trial tier selection carries the offer; picking another Pro tier
  // turns the card back into a pay-now card.
  const proTrialDays = isTrialSelection(trial, "pro", selectedTierByCard.pro)
    ? (trial?.days ?? null)
    : null;
  const cards = buildCards({
    currentPlan,
    currentTier,
    currentInterval,
    interval,
    selectedTierByCard,
    gasCreditCaps,
    hasSubscription,
    loadingCardId,
    freePriceDisplay,
    proTrialDays,
    onSelect: onCardCta,
  });

  const comparisonColumns = buildComparisonColumns();
  const comparisonRows = buildComparisonRows(
    currentPlan,
    gasCreditCaps,
    paygPriceUsdc
  );
  const dialogData = buildDialogData(confirmTarget, currentPlan, currentTier);

  return (
    <div className="space-y-8">
      <PricingCards
        cards={cards}
        interval={appIntervalToPkg(interval)}
        onIntervalChange={(next) => setInterval(pkgIntervalToApp(next))}
        onTierChange={onCardTierChange}
      />

      <PricingComparisonTable
        collapsible
        columns={comparisonColumns}
        currentColumnKey={currentPlan}
        defaultOpen
        rows={comparisonRows}
      />

      <ConfirmPlanChangeDialog
        currentExecutions={dialogData.currentExecutions}
        currentPlanName={currentPlan}
        gasCreditCaps={gasCreditCaps}
        interval={dialogData.appInterval}
        newExecutions={dialogData.newExecutions}
        newPlanName={dialogData.planName}
        newTier={dialogData.tierKey}
        onConfirm={() =>
          executeCheckout(
            {
              planName: dialogData.planName,
              tierKey: dialogData.tierKey,
              appInterval: dialogData.appInterval,
              trial: dialogData.trial,
            },
            handlers
          )
        }
        onOpenChange={setConfirmOpen}
        open={confirmOpen}
        planName={PLANS[dialogData.planName].name}
        price={dialogData.price}
        tierLabel={dialogData.tierLabel}
      />

      <p className="text-center text-muted-foreground text-xs">
        Paid tiers bill overage at the end of the cycle. Free tier caps at its
        limit with no overage.
      </p>
    </div>
  );
}
