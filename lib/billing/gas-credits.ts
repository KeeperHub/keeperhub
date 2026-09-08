import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { createPublicClient, http } from "viem";
import { db } from "@/lib/db";
import {
  gasCreditAllocations,
  gasCreditUsage,
} from "@/lib/db/schema-extensions";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  AGGREGATOR_V3_ABI,
  getGasTokenUsdFeedAddress,
} from "@/lib/web3/chainlink-feeds";
import { isBillingEnabled } from "./feature-flag";
import {
  getPlanLimits,
  type PlanLimits,
  type PlanName,
  parsePlanName,
} from "./plans";
import { getOrgSubscription } from "./plans-server";

const MICRO_USD_PER_CENT = 10_000;

const PLAN_ENV_KEYS: Record<PlanName, string> = {
  free: "GAS_CREDITS_FREE_CENTS",
  pro: "GAS_CREDITS_PRO_CENTS",
  business: "GAS_CREDITS_BUSINESS_CENTS",
  enterprise: "GAS_CREDITS_ENTERPRISE_CENTS",
};

/**
 * Get the gas credit cap for a plan.
 *
 * Precedence (most specific wins):
 *   1. Org-specific override on `organization_subscriptions.plan_overrides.gasCreditsCents`
 *   2. Env-var override per plan (e.g. GAS_CREDITS_PRO_CENTS)
 *   3. Hardcoded plan default
 */
export function getGasCreditCapCents(
  plan: PlanName,
  overrides?: Partial<PlanLimits> | null
): number {
  const orgOverride = overrides?.gasCreditsCents;
  if (typeof orgOverride === "number" && orgOverride >= 0) {
    return orgOverride;
  }
  const envVal = process.env[PLAN_ENV_KEYS[plan]];
  if (envVal !== undefined && envVal !== "") {
    const parsed = Number(envVal);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return getPlanLimits(plan).gasCreditsCents;
}

/**
 * Get the current gas credit caps for all plans (env-driven with fallbacks).
 * Intended for API responses so the UI can display accurate values.
 */
export function getGasCreditCaps(): Record<PlanName, number> {
  return {
    free: getGasCreditCapCents("free"),
    pro: getGasCreditCapCents("pro"),
    business: getGasCreditCapCents("business"),
    enterprise: getGasCreditCapCents("enterprise"),
  };
}

type GasCreditBalance = {
  totalCents: number;
  usedCents: number;
  remainingCents: number;
  plan: string;
};

type GasCreditCheckResult =
  | { allowed: true; remainingCents: number }
  | { allowed: false; reason: string };

/**
 * Resolve the gas credit allocation for an org in the current billing period.
 *
 * Snapshots the current env-driven cap to the DB. The snapshot self-heals
 * upward: if the org's derived cap has increased since the row was written
 * (plan upgrade, override raise, or env increase), the allocation is raised to
 * the new cap. It is never reduced within a period, so mid-period env decreases
 * and plan downgrades don't claw back credits an org is already relying on.
 */
async function resolveAllocation(
  organizationId: string,
  planName: PlanName,
  periodStart: Date,
  overrides?: Partial<PlanLimits> | null
): Promise<number> {
  const capCents = getGasCreditCapCents(planName, overrides);

  await db
    .insert(gasCreditAllocations)
    .values({
      organizationId,
      periodStart,
      allocatedCents: capCents,
    })
    .onConflictDoUpdate({
      target: [
        gasCreditAllocations.organizationId,
        gasCreditAllocations.periodStart,
      ],
      set: { allocatedCents: capCents },
      setWhere: sql`${gasCreditAllocations.allocatedCents} < ${capCents}`,
    });

  const row = await db
    .select({ allocatedCents: gasCreditAllocations.allocatedCents })
    .from(gasCreditAllocations)
    .where(
      and(
        eq(gasCreditAllocations.organizationId, organizationId),
        eq(gasCreditAllocations.periodStart, periodStart)
      )
    )
    .limit(1);

  return row[0]?.allocatedCents ?? capCents;
}

/**
 * Get the gas credit balance for an organization in the current billing period.
 *
 * Computes: persisted allocation - sum of gas_cost_micro_usd since period start.
 * If no subscription exists, uses the free plan defaults.
 */
export async function getGasCreditBalance(
  organizationId: string
): Promise<GasCreditBalance> {
  const sub = await getOrgSubscription(organizationId);
  const planName = parsePlanName(sub?.plan);
  const periodStart = sub?.currentPeriodStart ?? getDefaultPeriodStart();

  const totalCents = await resolveAllocation(
    organizationId,
    planName,
    periodStart,
    sub?.planOverrides
  );

  const result = await db
    .select({
      total: sql<string>`coalesce(sum(${gasCreditUsage.gasCostMicroUsd}::bigint), 0)::text`,
    })
    .from(gasCreditUsage)
    .where(
      and(
        eq(gasCreditUsage.organizationId, organizationId),
        gte(gasCreditUsage.createdAt, periodStart)
      )
    );

  // Round to nearest cent (not ceil) so "used" tracks real spend; the history
  // table still renders the exact micro-USD value.
  const usedMicroUsd = Number(result[0]?.total ?? "0");
  const usedCents = Math.round(usedMicroUsd / MICRO_USD_PER_CENT);
  const remainingCents = Math.max(0, totalCents - usedCents);

  return { totalCents, usedCents, remainingCents, plan: planName };
}

/**
 * Check if an organization has gas credits available for sponsorship.
 *
 * Returns { allowed: true } if billing is disabled (sponsorship is free)
 * or if credits remain. Returns { allowed: false } if credits are exhausted
 * for any plan (all plans block at cap, falling back to direct signing).
 */
export async function checkGasCredits(
  organizationId: string
): Promise<GasCreditCheckResult> {
  if (!isBillingEnabled()) {
    return { allowed: true, remainingCents: Number.MAX_SAFE_INTEGER };
  }

  const balance = await getGasCreditBalance(organizationId);

  if (balance.remainingCents > 0) {
    return { allowed: true, remainingCents: balance.remainingCents };
  }

  return {
    allowed: false,
    reason: "Gas credits exhausted for current billing period",
  };
}

type RecordGasUsageParams = {
  organizationId: string;
  chainId: number;
  txHash: string;
  executionId: string | undefined;
  gasUsed: bigint;
  gasPrice: bigint;
  ethPriceUsd: number;
};

/**
 * Record gas usage for a sponsored transaction.
 *
 * Converts gas cost from wei to micro-USD (1/1,000,000 of a dollar) for
 * sub-cent precision on L2s. Idempotent via unique constraint on
 * (organizationId, txHash).
 */
export async function recordGasUsage(
  params: RecordGasUsageParams
): Promise<void> {
  const gasCostWei = params.gasUsed * params.gasPrice;
  const gasCostEth = Number(gasCostWei) / 1e18;
  const gasCostMicroUsd = Math.ceil(
    gasCostEth * params.ethPriceUsd * 1_000_000
  );

  await db
    .insert(gasCreditUsage)
    .values({
      organizationId: params.organizationId,
      chainId: params.chainId,
      txHash: params.txHash,
      executionId: params.executionId,
      gasUsed: params.gasUsed.toString(),
      gasPriceWei: params.gasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      gasCostMicroUsd: gasCostMicroUsd.toString(),
      ethPriceUsd: params.ethPriceUsd.toString(),
    })
    .onConflictDoNothing();
}

// ETH price cache (60-second TTL, keyed by chainId)
const ethPriceCache = new Map<number, { usd: number; fetchedAt: number }>();
const ETH_PRICE_CACHE_TTL_MS = 60_000;
const STALE_PRICE_THRESHOLD_MS = 3_600_000; // 1 hour
const FALLBACK_ETH_PRICE_USD = 3000;

// Minimum gap between two reports of the same condition on the same chain.
// getGasTokenPriceUsd runs once per sponsored transaction, so an unthrottled
// report turns a single provider outage into one Sentry event and one metric
// increment per transaction for its whole duration. Keyed by severity as well
// as chain so an escalation from warn to error is reported immediately rather
// than swallowed by a window opened by the warning.
const FALLBACK_REPORT_INTERVAL_MS = 300_000; // 5 minutes
const fallbackReportedAt = new Map<string, number>();

/**
 * Report that a sponsored transaction is about to be billed against something
 * other than a fresh oracle read.
 *
 * `error` means the billed number is a hardcoded constant that tracks nothing,
 * or a cached price older than the same staleness threshold an oracle answer
 * itself is held to. `warn` means a real observed price that is merely past
 * its 60-second TTL.
 *
 * Never throws. The caller runs after the sponsored transaction is already
 * on-chain, where anything escaping is converted into SponsoredTxPendingError
 * and the org is never billed at all.
 */
function reportPriceFallback(args: {
  severity: "warn" | "error";
  chainId: number;
  now: number;
  message: string;
  error: unknown;
  labels: Record<string, string>;
}): void {
  const throttleKey = `${args.chainId}:${args.severity}`;
  const reportedAt = fallbackReportedAt.get(throttleKey);
  if (
    reportedAt !== undefined &&
    args.now - reportedAt < FALLBACK_REPORT_INTERVAL_MS
  ) {
    return;
  }
  fallbackReportedAt.set(throttleKey, args.now);

  try {
    const log = args.severity === "error" ? logSystemError : logSystemWarn;
    log(ErrorCategory.BILLING, args.message, args.error, {
      chain_id: String(args.chainId),
      ...args.labels,
    });
  } catch {
    // Reporting is best-effort; settling a confirmed transaction is not.
  }
}

/**
 * Fetch the current USD price of a chain's native gas token (ETH on the L1 and
 * ETH L2s, POL on Polygon) from the Chainlink oracle on that chain. Results are
 * cached for 60 seconds per chainId.
 * Fallback chain: oracle failure -> stale cache -> $3000 conservative estimate.
 */
export async function getGasTokenPriceUsd(
  rpcUrl: string,
  chainId: number
): Promise<number> {
  const now = Date.now();
  const cached = ethPriceCache.get(chainId);

  if (cached !== undefined && now - cached.fetchedAt < ETH_PRICE_CACHE_TTL_MS) {
    return cached.usd;
  }

  const feedAddress = getGasTokenUsdFeedAddress(chainId);
  if (feedAddress === undefined) {
    reportPriceFallback({
      severity: "error",
      chainId,
      now,
      message:
        "[GasCredits] No gas-token USD price feed configured for chain, billing on the hardcoded fallback",
      error: new Error(`No gas-token USD price feed for chain ${chainId}`),
      labels: { fallback_usd: String(FALLBACK_ETH_PRICE_USD) },
    });
    return FALLBACK_ETH_PRICE_USD;
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl) });

    const result = await client.readContract({
      address: feedAddress,
      abi: AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    });

    const [, answer, , updatedAt] = result;
    const updatedAtMs = Number(updatedAt) * 1000;

    if (now - updatedAtMs > STALE_PRICE_THRESHOLD_MS) {
      throw new Error(
        `Chainlink price stale: updatedAt ${new Date(updatedAtMs).toISOString()}`
      );
    }

    const price = Number(answer) / 1e8;

    if (price <= 0) {
      throw new Error(`Invalid Chainlink price: ${price}`);
    }

    ethPriceCache.set(chainId, { usd: price, fetchedAt: now });
    return price;
  } catch (error) {
    if (cached !== undefined) {
      const cachedAgeMs = now - cached.fetchedAt;
      reportPriceFallback({
        // A cached price still beats the hardcoded constant, so it is what
        // gets billed either way. But once it is older than the threshold an
        // oracle answer itself is rejected at, it has stopped being a recent
        // observation, and the feed has been failing for at least that long.
        severity: cachedAgeMs > STALE_PRICE_THRESHOLD_MS ? "error" : "warn",
        chainId,
        now,
        message:
          "[GasCredits] Gas-token price feed unavailable, billing on cached price",
        error,
        labels: {
          cached_usd: String(cached.usd),
          cached_age_ms: String(cachedAgeMs),
        },
      });
      return cached.usd;
    }
    reportPriceFallback({
      severity: "error",
      chainId,
      now,
      message:
        "[GasCredits] Gas-token price feed unavailable and no cached price, billing on the hardcoded fallback",
      error,
      labels: { fallback_usd: String(FALLBACK_ETH_PRICE_USD) },
    });
    return FALLBACK_ETH_PRICE_USD;
  }
}

/**
 * Default billing period start for orgs without a subscription.
 * Uses the 1st of the current month.
 */
function getDefaultPeriodStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
