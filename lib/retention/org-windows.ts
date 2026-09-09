import "server-only";

import { eq } from "drizzle-orm";
import {
  getPlanLimits,
  parsePlanName,
  parseTierKey,
} from "@/lib/billing/plans";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { organizationSubscriptions } from "@/lib/db/schema-extensions";
import type { RetentionConfig } from "@/lib/retention/config";

/** Organizations that share one retention window, in days. */
export type RetentionWindowGroup = {
  retentionDays: number;
  organizationIds: string[];
};

/**
 * How one run should carve up the table: one no-join pass at `floorDays`, and
 * one per-organization group for every window shorter than that.
 */
export type RetentionSchedule = {
  floorDays: number;
  groups: RetentionWindowGroup[];
  /** Every organization's resolved window, for reporting. */
  windows: Map<string, number>;
};

/**
 * KEEP-1042: resolve every organization's step-log retention window from the
 * plan it is on. `logRetentionDays` has been a product promise since
 * lib/billing/plans.ts was written (7 free, 30 pro, 90 business, 365
 * enterprise) and is advertised in the upsell modal, but until this job it had
 * no server-side reader at all.
 *
 * Resolution mirrors the entitlement path exactly: the plan alone decides, not
 * the subscription status, so a `trialing` or `past_due` Pro org keeps the Pro
 * window (see getOrgPlan / checkFeatureAccess in lib/billing/plans-server.ts).
 * A per-org `plan_overrides.logRetentionDays` wins, which is how a custom
 * contract gets a window the public plans do not offer.
 *
 * Two clamps keep a bad value from deleting live data: the configured floor
 * raises any window below it, and an org with no subscription row falls back to
 * the configured default rather than to zero. On prod that fallback covers most
 * organizations - 975 of 1409 have no subscription row - and it matches
 * getOrgPlan, which also reads a missing row as the free plan.
 */
export async function resolveOrgRetentionWindows(
  config: RetentionConfig
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      organizationId: organization.id,
      plan: organizationSubscriptions.plan,
      tier: organizationSubscriptions.tier,
      planOverrides: organizationSubscriptions.planOverrides,
    })
    .from(organization)
    .leftJoin(
      organizationSubscriptions,
      eq(organizationSubscriptions.organizationId, organization.id)
    );

  const windows = new Map<string, number>();
  for (const row of rows) {
    windows.set(row.organizationId, resolveRetentionDays(row, config));
  }
  return windows;
}

/** Exported for tests: the per-org window rule, with no database access. */
export function resolveRetentionDays(
  row: {
    plan: string | null;
    tier: string | null;
    planOverrides: Partial<{ logRetentionDays: number }> | null;
  },
  config: RetentionConfig
): number {
  if (row.plan === null) {
    return config.defaultLogRetentionDays;
  }
  const limits = getPlanLimits(
    parsePlanName(row.plan),
    parseTierKey(row.tier),
    row.planOverrides
  );
  const days = limits.logRetentionDays;
  if (!Number.isFinite(days) || days <= 0) {
    return config.defaultLogRetentionDays;
  }
  return Math.max(config.minLogRetentionDays, Math.trunc(days));
}

/**
 * Decide which pass owns which organizations.
 *
 * The no-join floor pass takes the LONGEST window in use, capped by the
 * configured ceiling. That matters for cost, not just tidiness: on prod the
 * organizations on the longest window hold 83% of the table, and the floor pass
 * is the only one that can reach them with a plain index range on `started_at`
 * instead of a three-table join. Everything strictly below the floor is grouped
 * by window and handled per organization.
 */
export function buildRetentionSchedule(
  windows: Map<string, number>,
  config: RetentionConfig
): RetentionSchedule {
  const longestWindow = Math.max(
    config.minLogRetentionDays,
    ...windows.values()
  );
  const floorDays = Math.min(
    config.executionLogFloorRetentionDays,
    longestWindow
  );

  const byDays = new Map<number, string[]>();
  for (const [organizationId, retentionDays] of windows) {
    if (retentionDays >= floorDays) {
      continue;
    }
    const bucket = byDays.get(retentionDays);
    if (bucket) {
      bucket.push(organizationId);
    } else {
      byDays.set(retentionDays, [organizationId]);
    }
  }

  const groups = [...byDays.entries()]
    .map(([retentionDays, organizationIds]) => ({
      retentionDays,
      organizationIds,
    }))
    .sort((a, b) => a.retentionDays - b.retentionDays);

  return { floorDays, groups, windows };
}
