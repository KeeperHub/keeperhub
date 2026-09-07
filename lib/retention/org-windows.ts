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
 * the configured default rather than to zero.
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
 * Collapse the per-org windows into one group per distinct window, dropping
 * every org whose window reaches the global floor. Those are already covered
 * by the floor pass, which needs no join at all, and they are the bulk of the
 * table: skipping them here is what keeps the per-org pass a narrow scan.
 */
export function groupByRetentionWindow(
  windows: Map<string, number>,
  config: RetentionConfig
): RetentionWindowGroup[] {
  const byDays = new Map<number, string[]>();
  for (const [organizationId, retentionDays] of windows) {
    if (retentionDays >= config.executionLogFloorRetentionDays) {
      continue;
    }
    const bucket = byDays.get(retentionDays);
    if (bucket) {
      bucket.push(organizationId);
    } else {
      byDays.set(retentionDays, [organizationId]);
    }
  }
  return [...byDays.entries()]
    .map(([retentionDays, organizationIds]) => ({
      retentionDays,
      organizationIds,
    }))
    .sort((a, b) => a.retentionDays - b.retentionDays);
}
