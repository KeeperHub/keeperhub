import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, organizationSubscriptions } from "@/lib/db/schema";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import {
  isValidPlanName,
  isValidTierKey,
  type PlanLimits,
  type PlanName,
  type TierKey,
} from "./plans";

/**
 * The org's stored subscription row, or undefined when it has none.
 *
 * Its own module so the quota-notification path can re-read the plan without
 * importing plans-server, which imports the notification path back.
 */
export async function getOrgSubscription(
  organizationId: string
): Promise<typeof organizationSubscriptions.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, organizationId))
    .limit(1);
  return rows[0];
}

export type OrgSubscriptionRead = {
  /** False means the read itself is untrustworthy, not that the org is free. */
  orgExists: boolean;
  subscription: typeof organizationSubscriptions.$inferSelect | null;
};

/**
 * The org's subscription resolved through its organization row.
 *
 * getOrgSubscription cannot tell "this org has no subscription" from "this
 * read returned nothing", and callers collapse both to the free plan, which is
 * also a real plan. Joining from organization makes the difference observable:
 * the org row has to come back before an absent subscription means anything.
 */
export async function readOrgSubscription(
  organizationId: string
): Promise<OrgSubscriptionRead> {
  const rows = await db
    .select({
      orgId: organization.id,
      subscription: organizationSubscriptions,
    })
    .from(organization)
    .leftJoin(
      organizationSubscriptions,
      eq(organizationSubscriptions.organizationId, organization.id)
    )
    .where(eq(organization.id, organizationId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { orgExists: false, subscription: null };
  }
  return { orgExists: true, subscription: row.subscription };
}

export type ResolvedOrgPlan = {
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null;
  status: string | null;
};

/**
 * The org's plan as actually stored, or null when it cannot be established.
 *
 * "free" is both a real plan, the pay-per-execution one, and the value every
 * unresolved read collapses to through parsePlanName, so a caller that defaults
 * cannot tell a payg org from a read it should not have trusted. It then either
 * mails that org a quota warning it has no quota for, or gates it at 5,000
 * executions and charges its wallet per run.
 *
 * Null is returned for the three cases that are not a plan: the organization
 * row did not come back, so an absent subscription proves nothing; the stored
 * plan is not a plan we model; the stored tier is set but is not a tier we
 * model. An absent subscription on an org that did come back is a real answer,
 * and resolves to free.
 */
export async function resolveOrgPlan(
  organizationId: string
): Promise<ResolvedOrgPlan | null> {
  const read = await readOrgSubscription(organizationId);

  if (!read.orgExists) {
    logSystemWarn(
      ErrorCategory.BILLING,
      "[PlanResolution] Organization did not resolve; plan is unknown",
      undefined,
      { organization_id: organizationId }
    );
    return null;
  }

  const sub = read.subscription;
  if (sub === null) {
    return { plan: "free", tier: null, planOverrides: null, status: null };
  }

  if (!isValidPlanName(sub.plan)) {
    logSystemWarn(
      ErrorCategory.BILLING,
      "[PlanResolution] Stored plan is not a plan we model",
      undefined,
      { organization_id: organizationId, stored_plan: String(sub.plan) }
    );
    return null;
  }

  // Null is a real answer here and means the plan's base allowance. A set tier
  // that is not one we model is not, and falling back to that base allowance
  // would silently measure the org against a smaller quota than it pays for.
  const tier = sub.tier ?? null;
  if (tier !== null && !isValidTierKey(tier)) {
    logSystemWarn(
      ErrorCategory.BILLING,
      "[PlanResolution] Stored tier is not a tier we model",
      undefined,
      { organization_id: organizationId, stored_tier: String(tier) }
    );
    return null;
  }

  return {
    plan: sub.plan,
    tier,
    planOverrides: sub.planOverrides ?? null,
    status: sub.status ?? null,
  };
}
