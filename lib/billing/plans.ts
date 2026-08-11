// Client-safe plan definitions and utilities.
// No server-side imports (db, drizzle) allowed here.
// Server-only query helpers are in plans-server.ts.

// -- Types --

export type PlanName = "free" | "pro" | "business" | "enterprise";

export type TierKey = "25k" | "50k" | "100k" | "250k" | "500k" | "1m";

type PlanTier = {
  key: TierKey;
  executions: number;
  monthlyPrice: number;
  monthlyPriceAnnual: number;
};

export type PlanLimits = {
  maxExecutionsPerMonth: number;
  gasCreditsCents: number;
  maxWorkflows: number; // -1 = unlimited
  apiAccess: "rate-limited" | "full";
  logRetentionDays: number;
  supportLevel: "community" | "email-48h" | "dedicated-12h" | "dedicated-1h";
  sla: string | null;
};

type OverageConfig = {
  enabled: boolean;
  ratePerThousand: number;
};

type PlanDefinition = {
  name: string;
  description: string;
  features: PlanLimits;
  tiers: PlanTier[];
  overage: OverageConfig;
};

export type BillingInterval = "monthly" | "yearly";

const VALID_PLAN_NAMES: ReadonlySet<string> = new Set<PlanName>([
  "free",
  "pro",
  "business",
  "enterprise",
]);

const VALID_TIER_KEYS: ReadonlySet<string> = new Set<TierKey>([
  "25k",
  "50k",
  "100k",
  "250k",
  "500k",
  "1m",
]);

// A free trial applies to the entry Pro tier only. Whether trials run at all is
// the TRIALS_ENABLED flag; the tier they run on is not an operating knob, so
// TRIAL_TIER (resolved in lib/billing/trial.ts) accepts nothing else and any
// other value falls back to the default. Every other plan and tier is pay-now.
export const TRIAL_PLAN_NAME: PlanName = "pro";
// Pay-as-you-go is offered on this plan only; every other plan either bills
// overage past its included limit or is unlimited.
export const PAYG_PLAN_NAME: PlanName = "free";
export const DEFAULT_TRIAL_TIER_KEY: TierKey = "25k";
export const TRIAL_ELIGIBLE_TIER_KEYS: readonly TierKey[] = ["25k"];

export function isValidPlanName(value: unknown): value is PlanName {
  return typeof value === "string" && VALID_PLAN_NAMES.has(value);
}

export function isValidTierKey(value: unknown): value is TierKey {
  return typeof value === "string" && VALID_TIER_KEYS.has(value);
}

export function parsePlanName(
  value: unknown,
  fallback: PlanName = "free"
): PlanName {
  return isValidPlanName(value) ? value : fallback;
}

export function parseTierKey(value: unknown): TierKey | null {
  return isValidTierKey(value) ? value : null;
}

// -- Plan definitions --

export const PLANS: Record<PlanName, PlanDefinition> = {
  free: {
    name: "Free",
    description: "Get started with Web3 automation",
    features: {
      maxExecutionsPerMonth: 5000,
      gasCreditsCents: 100,
      maxWorkflows: -1,
      apiAccess: "rate-limited",
      logRetentionDays: 7,
      supportLevel: "community",
      sla: null,
    },
    tiers: [],
    overage: { enabled: false, ratePerThousand: 0 },
  },
  pro: {
    name: "Pro",
    description: "Scale your automation workflows",
    features: {
      maxExecutionsPerMonth: 25_000,
      gasCreditsCents: 500,
      maxWorkflows: -1,
      apiAccess: "full",
      logRetentionDays: 30,
      supportLevel: "email-48h",
      sla: null,
    },
    tiers: [
      {
        key: "25k",
        executions: 25_000,
        monthlyPrice: 49,
        monthlyPriceAnnual: 39,
      },
      {
        key: "50k",
        executions: 50_000,
        monthlyPrice: 89,
        monthlyPriceAnnual: 71,
      },
      {
        key: "100k",
        executions: 100_000,
        monthlyPrice: 149,
        monthlyPriceAnnual: 119,
      },
    ],
    overage: { enabled: true, ratePerThousand: 2 },
  },
  business: {
    name: "Business",
    description: "Enterprise-grade automation at scale",
    features: {
      maxExecutionsPerMonth: 250_000,
      gasCreditsCents: 2500,
      maxWorkflows: -1,
      apiAccess: "full",
      logRetentionDays: 90,
      supportLevel: "dedicated-12h",
      sla: "99.9%",
    },
    tiers: [
      {
        key: "250k",
        executions: 250_000,
        monthlyPrice: 299,
        monthlyPriceAnnual: 239,
      },
      {
        key: "500k",
        executions: 500_000,
        monthlyPrice: 499,
        monthlyPriceAnnual: 399,
      },
      {
        key: "1m",
        executions: 1_000_000,
        monthlyPrice: 899,
        monthlyPriceAnnual: 719,
      },
    ],
    overage: { enabled: true, ratePerThousand: 1.5 },
  },
  enterprise: {
    name: "Enterprise",
    description: "Custom solutions for large organizations",
    features: {
      maxExecutionsPerMonth: -1,
      gasCreditsCents: 10_000,
      maxWorkflows: -1,
      apiAccess: "full",
      logRetentionDays: 365,
      supportLevel: "dedicated-1h",
      sla: "99.99%",
    },
    tiers: [],
    overage: { enabled: false, ratePerThousand: 0 },
  },
} as const;

// Whether the plan bills overage past its included limit. Overage and
// pay-as-you-go are the two ways to run past the limit, and no plan has both.
export function billsOverage(plan: PlanName): boolean {
  return PLANS[plan].overage.enabled;
}

// Whether `value` is a Pro tier that may be configured as the trial tier.
// Guards the TRIAL_TIER env against a plan/tier that does not exist.
export function isConfigurableTrialTier(value: unknown): value is TierKey {
  return (
    typeof value === "string" &&
    (TRIAL_ELIGIBLE_TIER_KEYS as readonly string[]).includes(value) &&
    PLANS[TRIAL_PLAN_NAME].tiers.some((t) => t.key === value)
  );
}

// -- Shared helpers (no DB) --

export function getPlanLimits(
  plan: PlanName,
  tier?: TierKey | null,
  overrides?: Partial<PlanLimits> | null
): PlanLimits {
  const planDef = PLANS[plan];
  const limits = { ...planDef.features };

  if (tier && planDef.tiers.length > 0) {
    const selectedTier = planDef.tiers.find((t) => t.key === tier);
    if (selectedTier) {
      limits.maxExecutionsPerMonth = selectedTier.executions;
    }
  }

  // Per-org overrides win over tier and plan defaults. Used for custom enterprise
  // contracts (e.g. higher gas credits, custom SLA) that exceed the public plan.
  if (overrides) {
    for (const key of Object.keys(overrides) as (keyof PlanLimits)[]) {
      const value = overrides[key];
      if (value !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: PlanLimits is a heterogeneous record; per-key narrowing is unnecessary here
        (limits as any)[key] = value;
      }
    }
  }

  return limits;
}
