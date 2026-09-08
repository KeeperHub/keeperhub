import "server-only";

// Plan admission for pre-created (phantom) dispatches.
//
// The executor is still the authoritative gate: it re-runs these checks before
// it claims a row or creates a runner pod. This runs earlier, at phantom
// creation, so a dispatch that is already known to be refused never costs a
// row, an SQS message and an executor round-trip.
//
// Only deterministic refusals belong here. A free org past its included limit
// is admitted on purpose: pay-as-you-go charges it per execution and the charge
// is settled on the executor after the claim, so refusing it here would drop
// runs the org is entitled to.

import {
  extractActionTypeNodes,
  validateWorkflowFeatures,
} from "@/lib/features";
import { isBillingEnabled } from "./feature-flag";
import type { PlanName } from "./plans";
import { checkExecutionLimit, getOrgPlan } from "./plans-server";

export type DispatchRefusalReason = "plan_feature" | "execution_limit";

export type DispatchRefusal = {
  reason: DispatchRefusalReason;
  message: string;
};

// Both strings match what the executor writes when it refuses the same run, so
// a refusal reads identically whether it was caught here or one hop later.
export const EXECUTION_LIMIT_REFUSAL =
  "Execution skipped: your plan's monthly execution limit has been reached.";

export function planFeatureRefusalMessage(
  featureNames: readonly string[]
): string {
  return `Workflow uses features that require a paid plan: ${featureNames.join(", ")}`;
}

/**
 * Org-level standing: the part of the decision that costs database reads and is
 * identical for every workflow the org owns.
 */
type OrgStanding = { plan: PlanName; limitBlocked: boolean };

// A dispatcher calls this on every occurrence of every trigger, which on a fast
// block trigger is tens of times a minute for the same org. Without this the
// admitted path (the common one) would pay three point-lookups per occurrence
// to spare the refused path its round-trip, which is a net loss at any healthy
// refusal ratio.
//
// Both outcomes are cached. A stale admission is harmless: the executor still
// refuses. A stale refusal delays the first run after an upgrade by at most the
// TTL, which is why the TTL is seconds rather than minutes.
const STANDING_TTL_MS = 30_000;

// Nothing reads an entry back once it has expired, so without a bound the map
// would retain one entry per org that has ever dispatched for the lifetime of
// the pod. The cap is well above the number of orgs dispatching inside any one
// TTL window, so eviction is a safety net rather than part of the hot path.
const STANDING_CACHE_MAX = 5000;

const standingCache = new Map<
  string,
  { expiresAt: number; standing: OrgStanding }
>();

/**
 * Drop expired entries, then the oldest writes if the cap is still exceeded.
 * Insertion order is write order (every write re-inserts), so the oldest keys
 * are also the closest to expiring.
 */
function evictStandings(now: number): void {
  for (const [orgId, entry] of standingCache) {
    if (entry.expiresAt <= now) {
      standingCache.delete(orgId);
    }
  }

  let overflow = standingCache.size - STANDING_CACHE_MAX;
  for (const orgId of standingCache.keys()) {
    if (overflow <= 0) {
      return;
    }
    standingCache.delete(orgId);
    overflow--;
  }
}

async function readOrgStanding(organizationId: string): Promise<OrgStanding> {
  const cached = standingCache.get(organizationId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.standing;
  }

  const [plan, limit] = await Promise.all([
    getOrgPlan(organizationId),
    checkExecutionLimit(organizationId),
  ]);
  const standing: OrgStanding = { plan, limitBlocked: !limit.allowed };
  if (standingCache.size >= STANDING_CACHE_MAX) {
    evictStandings(now);
  }
  // Re-insert so the key moves to the back of the eviction order.
  standingCache.delete(organizationId);
  standingCache.set(organizationId, {
    expiresAt: now + STANDING_TTL_MS,
    standing,
  });
  return standing;
}

/**
 * Clear the cache. Test-only - throws outside NODE_ENV=test so production code
 * that calls it by mistake fails loud instead of silently dropping the cache.
 */
export function __resetDispatchAdmissionCacheForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "__resetDispatchAdmissionCacheForTest is test-only; do not call in production"
    );
  }
  standingCache.clear();
}

/**
 * Decide whether a dispatch may be pre-created. Returns null to admit, or the
 * refusal to record and report back to the dispatcher.
 */
export async function checkDispatchAdmission(params: {
  organizationId: string | null | undefined;
  nodes: readonly unknown[];
}): Promise<DispatchRefusal | null> {
  if (!isBillingEnabled()) {
    return null;
  }

  // Default-deny on plan features: no org context means no paid plan we can
  // read, so the workflow is validated against free, and there is nothing to
  // bill. Mirrors enforceWorkflowFeatures and enforceExecutionLimit.
  const standing: OrgStanding = params.organizationId
    ? await readOrgStanding(params.organizationId)
    : { plan: "free", limitBlocked: false };

  // Per-workflow and free: which nodes are gated depends on the definition, so
  // this part must not be cached per org.
  const violations = validateWorkflowFeatures(
    extractActionTypeNodes(params.nodes),
    standing.plan
  );
  if (violations.length > 0) {
    return {
      reason: "plan_feature",
      message: planFeatureRefusalMessage(violations.map((v) => v.feature.name)),
    };
  }

  if (standing.limitBlocked) {
    return { reason: "execution_limit", message: EXECUTION_LIMIT_REFUSAL };
  }

  return null;
}
