/**
 * Database-backed Metrics Collection
 *
 * Queries execution statistics from the database and exposes them as Prometheus metrics.
 * This is necessary because workflow runner jobs exit before Prometheus can scrape them.
 *
 * These metrics are collected on each /api/metrics scrape to ensure fresh data.
 */

import "server-only";

import { and, count, countDistinct, eq, gte, sql } from "drizzle-orm";
import {
  PLANS,
  type PlanName,
  parsePlanName,
  parseTierKey,
  type TierKey,
} from "@/lib/billing/plans";
import { db } from "@/lib/db";
import {
  apiKeys,
  chains,
  integrations,
  invitation,
  member,
  organization,
  organizationSubscriptions,
  paraWallets,
  sessions,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflowRatings,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import type { BillingStatus } from "./types";

// Label value used for workflow executions whose workflow has no organization
// (personal/anonymous workflows). Keeps the per-(status, org_slug) execution
// gauge total equal to the global total instead of silently dropping these
// rows. Also re-exported for the runtime finalization counter so personal
// workflows still produce a series rather than silently dropping increments.
export const ANONYMOUS_ORG_SLUG = "_anonymous";

// Histogram bucket boundaries in milliseconds (must match prometheus.ts)
const WORKFLOW_DURATION_BUCKETS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 30_000,
];
const STEP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000];

export type WorkflowStats = {
  // Total executions by status (sum across all orgs)
  totalSuccess: number;
  totalError: number;
  totalRunning: number;
  totalPending: number;
  totalCancelled: number;

  // Per-(status, org_slug) execution counts. Personal/anonymous workflows
  // are bucketed under ANONYMOUS_ORG_SLUG so the sum of counts for a given
  // status across all orgs matches the corresponding total* above.
  executionsByStatusAndOrgSlug: Array<{
    status: string;
    orgSlug: string;
    count: number;
  }>;

  // Duration histogram data (count of executions in each bucket)
  durationBuckets: number[];
  durationSum: number;
  durationCount: number;
};

/**
 * Query workflow execution statistics from the database
 *
 * Returns counts and duration distribution for all completed executions.
 * This data is used to populate Prometheus metrics on each scrape.
 */
export async function getWorkflowStatsFromDb(): Promise<WorkflowStats> {
  try {
    const stats: WorkflowStats = {
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: new Array(WORKFLOW_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };

    // Per-(status, org_slug) execution breakdown: JOIN workflows + organization,
    // LEFT JOIN so anonymous workflows still contribute (under ANONYMOUS_ORG_SLUG).
    // GROUP BY uses the organization.slug column reference (not the COALESCE
    // expression): Drizzle would otherwise bind ANONYMOUS_ORG_SLUG as separate
    // parameters in SELECT and GROUP BY clauses, and Postgres rejects the query
    // because the two COALESCE expressions are not textually identical. Postgres
    // groups all NULL slugs into one group (NULLs are equal in GROUP BY), and
    // the SELECT-side COALESCE renders that group as ANONYMOUS_ORG_SLUG.
    const breakdown = await db
      .select({
        status: workflowExecutions.status,
        orgSlug: sql<string>`COALESCE(${organization.slug}, ${ANONYMOUS_ORG_SLUG})`,
        count: count(),
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .groupBy(workflowExecutions.status, organization.slug);

    for (const row of breakdown) {
      const c = Number(row.count) || 0;
      stats.executionsByStatusAndOrgSlug.push({
        status: row.status,
        orgSlug: row.orgSlug,
        count: c,
      });
      switch (row.status) {
        case "success":
          stats.totalSuccess += c;
          break;
        case "error":
          stats.totalError += c;
          break;
        case "running":
          stats.totalRunning += c;
          break;
        case "pending":
          stats.totalPending += c;
          break;
        case "cancelled":
          stats.totalCancelled += c;
          break;
        default:
          // Ignore unknown status values
          break;
      }
    }

    // Query duration histogram data for completed executions
    // Build bucket counts using SQL CASE statements for efficiency
    const durationQuery = await db
      .select({
        totalCount: count(),
        totalSum: sql<number>`COALESCE(SUM(${workflowExecutions.duration}), 0)`,
        // Count executions in each bucket (cumulative)
        bucket0: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 100 THEN 1 ELSE 0 END)`,
        bucket1: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 250 THEN 1 ELSE 0 END)`,
        bucket2: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 500 THEN 1 ELSE 0 END)`,
        bucket3: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 1000 THEN 1 ELSE 0 END)`,
        bucket4: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 2000 THEN 1 ELSE 0 END)`,
        bucket5: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 5000 THEN 1 ELSE 0 END)`,
        bucket6: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 10000 THEN 1 ELSE 0 END)`,
        bucket7: sql<number>`SUM(CASE WHEN ${workflowExecutions.duration} <= 30000 THEN 1 ELSE 0 END)`,
      })
      .from(workflowExecutions)
      .where(
        and(
          sql`${workflowExecutions.status} IN ('success', 'error')`,
          sql`${workflowExecutions.duration} IS NOT NULL`
        )
      );

    if (durationQuery[0]) {
      const row = durationQuery[0];
      stats.durationCount = Number(row.totalCount) || 0;
      stats.durationSum = Number(row.totalSum) || 0;
      stats.durationBuckets = [
        Number(row.bucket0) || 0,
        Number(row.bucket1) || 0,
        Number(row.bucket2) || 0,
        Number(row.bucket3) || 0,
        Number(row.bucket4) || 0,
        Number(row.bucket5) || 0,
        Number(row.bucket6) || 0,
        Number(row.bucket7) || 0,
        stats.durationCount, // +Inf bucket = total count
      ];
    }

    return stats;
  } catch (error) {
    console.error("[Metrics] Failed to query workflow stats from DB:", error);
    // Return zeros on error to avoid breaking metrics endpoint
    return {
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      executionsByStatusAndOrgSlug: [],
      durationBuckets: new Array(WORKFLOW_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };
  }
}

export type StepStats = {
  // Counts by step type and status
  countsByType: Record<string, { success: number; error: number }>;

  // Duration histogram data (count of steps in each bucket)
  durationBuckets: number[];
  durationSum: number;
  durationCount: number;
};

// Helper to parse step duration buckets from query result
function parseStepDurationBuckets(row: {
  totalCount: number;
  totalSum: number;
  bucket0: number;
  bucket1: number;
  bucket2: number;
  bucket3: number;
  bucket4: number;
  bucket5: number;
  bucket6: number;
}): { buckets: number[]; sum: number; count: number } {
  const totalCount = Number(row.totalCount) || 0;
  return {
    count: totalCount,
    sum: Number(row.totalSum) || 0,
    buckets: [
      Number(row.bucket0) || 0,
      Number(row.bucket1) || 0,
      Number(row.bucket2) || 0,
      Number(row.bucket3) || 0,
      Number(row.bucket4) || 0,
      Number(row.bucket5) || 0,
      Number(row.bucket6) || 0,
      totalCount, // +Inf bucket = total count
    ],
  };
}

/**
 * Query step execution statistics from the database
 *
 * Returns counts and duration distribution for all completed steps.
 * This data is used to populate Prometheus metrics on each scrape.
 */
export async function getStepStatsFromDb(): Promise<StepStats> {
  try {
    // Query step counts by type and status
    const typeCounts = await db
      .select({
        nodeType: workflowExecutionLogs.nodeType,
        status: workflowExecutionLogs.status,
        count: count(),
      })
      .from(workflowExecutionLogs)
      .where(sql`${workflowExecutionLogs.status} IN ('success', 'error')`)
      .groupBy(workflowExecutionLogs.nodeType, workflowExecutionLogs.status);

    const stats: StepStats = {
      countsByType: {},
      durationBuckets: new Array(STEP_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };

    for (const row of typeCounts) {
      if (!stats.countsByType[row.nodeType]) {
        stats.countsByType[row.nodeType] = { success: 0, error: 0 };
      }
      if (row.status === "success") {
        stats.countsByType[row.nodeType].success = row.count;
      } else if (row.status === "error") {
        stats.countsByType[row.nodeType].error = row.count;
      }
    }

    // Query duration histogram data for completed steps
    const durationQuery = await db
      .select({
        totalCount: count(),
        totalSum: sql<number>`COALESCE(SUM(${workflowExecutionLogs.duration}), 0)`,
        // Count steps in each bucket (cumulative)
        bucket0: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 50 THEN 1 ELSE 0 END)`,
        bucket1: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 100 THEN 1 ELSE 0 END)`,
        bucket2: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 250 THEN 1 ELSE 0 END)`,
        bucket3: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 500 THEN 1 ELSE 0 END)`,
        bucket4: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 1000 THEN 1 ELSE 0 END)`,
        bucket5: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 2000 THEN 1 ELSE 0 END)`,
        bucket6: sql<number>`SUM(CASE WHEN ${workflowExecutionLogs.duration} <= 5000 THEN 1 ELSE 0 END)`,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          sql`${workflowExecutionLogs.status} IN ('success', 'error')`,
          sql`${workflowExecutionLogs.duration} IS NOT NULL`
        )
      );

    if (durationQuery[0]) {
      const parsed = parseStepDurationBuckets(durationQuery[0]);
      stats.durationCount = parsed.count;
      stats.durationSum = parsed.sum;
      stats.durationBuckets = parsed.buckets;
    }

    return stats;
  } catch (error) {
    console.error("[Metrics] Failed to query step stats from DB:", error);
    // Return zeros on error to avoid breaking metrics endpoint
    return {
      countsByType: {},
      durationBuckets: new Array(STEP_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };
  }
}

/**
 * Query daily active users from the database
 *
 * Returns count of distinct users with active sessions in the last 24 hours.
 */
export async function getDailyActiveUsersFromDb(): Promise<number> {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db
      .select({
        count: countDistinct(sessions.userId),
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.updatedAt, oneDayAgo),
          gte(sessions.expiresAt, new Date()) // Only count non-expired sessions
        )
      );

    return Number(result[0]?.count) || 0;
  } catch (error) {
    console.error(
      "[Metrics] Failed to query daily active users from DB:",
      error
    );
    return 0;
  }
}

export type UserStats = {
  total: number;
  verified: number;
  anonymous: number;
  withWorkflows: number;
  withIntegrations: number;
};

/**
 * Query user statistics from the database
 *
 * Returns counts of users by various categories.
 */
export async function getUserStatsFromDb(): Promise<UserStats> {
  try {
    const [
      totalResult,
      verifiedResult,
      anonymousResult,
      withWorkflowsResult,
      withIntegrationsResult,
    ] = await Promise.all([
      // Total users
      db.select({ count: count() }).from(users),
      // Verified users
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.emailVerified, true)),
      // Anonymous users
      db
        .select({ count: count() })
        .from(users)
        .where(eq(users.isAnonymous, true)),
      // Users with at least one workflow
      db.select({ count: countDistinct(workflows.userId) }).from(workflows),
      // Users with at least one integration
      db
        .select({ count: countDistinct(integrations.userId) })
        .from(integrations),
    ]);

    return {
      total: Number(totalResult[0]?.count) || 0,
      verified: Number(verifiedResult[0]?.count) || 0,
      anonymous: Number(anonymousResult[0]?.count) || 0,
      withWorkflows: Number(withWorkflowsResult[0]?.count) || 0,
      withIntegrations: Number(withIntegrationsResult[0]?.count) || 0,
    };
  } catch (error) {
    console.error("[Metrics] Failed to query user stats from DB:", error);
    return {
      total: 0,
      verified: 0,
      anonymous: 0,
      withWorkflows: 0,
      withIntegrations: 0,
    };
  }
}

export type OrgStats = {
  total: number;
  membersTotal: number;
  membersByRole: Record<string, number>;
  invitationsPending: number;
  withWorkflows: number;
};

/**
 * Query organization statistics from the database
 *
 * Returns counts of organizations and their members.
 */
export async function getOrgStatsFromDb(): Promise<OrgStats> {
  try {
    const [
      totalResult,
      membersTotalResult,
      membersByRoleResult,
      invitationsPendingResult,
      withWorkflowsResult,
    ] = await Promise.all([
      // Total organizations
      db.select({ count: count() }).from(organization),
      // Total members across all orgs
      db.select({ count: count() }).from(member),
      // Members grouped by role
      db
        .select({
          role: member.role,
          count: count(),
        })
        .from(member)
        .groupBy(member.role),
      // Pending invitations
      db
        .select({ count: count() })
        .from(invitation)
        .where(eq(invitation.status, "pending")),
      // Organizations with at least one workflow
      db
        .select({ count: countDistinct(workflows.organizationId) })
        .from(workflows)
        .where(sql`${workflows.organizationId} IS NOT NULL`),
    ]);

    const membersByRole: Record<string, number> = {};
    for (const row of membersByRoleResult) {
      membersByRole[row.role] = row.count;
    }

    return {
      total: Number(totalResult[0]?.count) || 0,
      membersTotal: Number(membersTotalResult[0]?.count) || 0,
      membersByRole,
      invitationsPending: Number(invitationsPendingResult[0]?.count) || 0,
      withWorkflows: Number(withWorkflowsResult[0]?.count) || 0,
    };
  } catch (error) {
    console.error("[Metrics] Failed to query org stats from DB:", error);
    return {
      total: 0,
      membersTotal: 0,
      membersByRole: {},
      invitationsPending: 0,
      withWorkflows: 0,
    };
  }
}

export type UserListEntry = {
  email: string;
  name: string;
  verified: boolean;
  createdAt: Date;
};

export async function getUserListFromDb(): Promise<UserListEntry[]> {
  try {
    const result = await db
      .select({
        email: users.email,
        name: users.name,
        verified: users.emailVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.isAnonymous, false));

    return result.map((row) => ({
      email: row.email ?? "unknown",
      name: row.name ?? "unknown",
      verified: row.verified,
      createdAt: row.createdAt,
    }));
  } catch (error) {
    console.error("[Metrics] Failed to query user list from DB:", error);
    return [];
  }
}

export type OrgListEntry = {
  name: string;
  slug: string;
  plan: PlanName;
  tier: TierKey | null;
  billingStatus: BillingStatus;
};

const VALID_BILLING_STATUSES: ReadonlySet<string> = new Set<BillingStatus>([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
  "none",
]);

function parseBillingStatus(value: unknown): BillingStatus {
  return typeof value === "string" && VALID_BILLING_STATUSES.has(value)
    ? (value as BillingStatus)
    : "none";
}

export async function getOrgListFromDb(): Promise<OrgListEntry[]> {
  try {
    const result = await db
      .select({
        name: organization.name,
        slug: organization.slug,
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        billingStatus: organizationSubscriptions.status,
      })
      .from(organization)
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      );

    return result.map((row) => ({
      name: row.name,
      slug: row.slug,
      plan: parsePlanName(row.plan, "free"),
      tier: parseTierKey(row.tier),
      billingStatus:
        row.billingStatus === null
          ? "none"
          : parseBillingStatus(row.billingStatus),
    }));
  } catch (error) {
    console.error("[Metrics] Failed to query org list from DB:", error);
    return [];
  }
}

export type WorkflowDefinitionStats = {
  total: number;
  public: number;
  private: number;
  anonymous: number;
};

/**
 * Query workflow definition statistics from the database
 *
 * Returns counts of workflows by visibility and anonymity.
 */
export async function getWorkflowDefinitionStatsFromDb(): Promise<WorkflowDefinitionStats> {
  try {
    const [totalResult, publicResult, anonymousResult] = await Promise.all([
      db.select({ count: count() }).from(workflows),
      db
        .select({ count: count() })
        .from(workflows)
        .where(eq(workflows.visibility, "public")),
      db
        .select({ count: count() })
        .from(workflows)
        .where(eq(workflows.isAnonymous, true)),
    ]);

    const total = Number(totalResult[0]?.count) || 0;
    const publicCount = Number(publicResult[0]?.count) || 0;

    return {
      total,
      public: publicCount,
      private: total - publicCount,
      anonymous: Number(anonymousResult[0]?.count) || 0,
    };
  } catch (error) {
    console.error(
      "[Metrics] Failed to query workflow definition stats from DB:",
      error
    );
    return { total: 0, public: 0, private: 0, anonymous: 0 };
  }
}

export type ScheduleStats = {
  total: number;
  enabled: number;
  disabled: number;
  byLastStatus: Record<string, number>;
};

/**
 * Query schedule statistics from the database
 *
 * Returns counts of schedules by enabled state and last run status.
 */
export async function getScheduleStatsFromDb(): Promise<ScheduleStats> {
  try {
    const [totalResult, enabledResult, statusResult] = await Promise.all([
      db.select({ count: count() }).from(workflowSchedules),
      db
        .select({ count: count() })
        .from(workflowSchedules)
        .where(eq(workflowSchedules.enabled, true)),
      db
        .select({
          status: workflowSchedules.lastStatus,
          count: count(),
        })
        .from(workflowSchedules)
        .where(sql`${workflowSchedules.lastStatus} IS NOT NULL`)
        .groupBy(workflowSchedules.lastStatus),
    ]);

    const total = Number(totalResult[0]?.count) || 0;
    const enabled = Number(enabledResult[0]?.count) || 0;

    const byLastStatus: Record<string, number> = {};
    for (const row of statusResult) {
      if (row.status) {
        byLastStatus[row.status] = row.count;
      }
    }

    return {
      total,
      enabled,
      disabled: total - enabled,
      byLastStatus,
    };
  } catch (error) {
    console.error("[Metrics] Failed to query schedule stats from DB:", error);
    return { total: 0, enabled: 0, disabled: 0, byLastStatus: {} };
  }
}

export type IntegrationStats = {
  total: number;
  managed: number;
  byType: Record<string, number>;
};

/**
 * Query integration statistics from the database
 *
 * Returns counts of integrations by type and managed status.
 */
export async function getIntegrationStatsFromDb(): Promise<IntegrationStats> {
  try {
    const [totalResult, managedResult, typeResult] = await Promise.all([
      db.select({ count: count() }).from(integrations),
      db
        .select({ count: count() })
        .from(integrations)
        .where(eq(integrations.isManaged, true)),
      db
        .select({
          type: integrations.type,
          count: count(),
        })
        .from(integrations)
        .groupBy(integrations.type),
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeResult) {
      byType[row.type] = row.count;
    }

    return {
      total: Number(totalResult[0]?.count) || 0,
      managed: Number(managedResult[0]?.count) || 0,
      byType,
    };
  } catch (error) {
    console.error(
      "[Metrics] Failed to query integration stats from DB:",
      error
    );
    return { total: 0, managed: 0, byType: {} };
  }
}

export type InfraStats = {
  apiKeysTotal: number;
  chainsTotal: number;
  chainsEnabled: number;
  /**
   * @deprecated Counts all active org wallets regardless of provider.
   * Kept for backward compatibility with the `keeperhub_para_wallet_total`
   * gauge. Use `walletsByProvider` instead.
   */
  paraWalletsTotal: number;
  walletsByProvider: {
    para: number;
    turnkey: number;
  };
  sessionsActive: number;
};

/**
 * Query infrastructure statistics from the database
 *
 * Returns counts of API keys, chains, wallets, and active sessions.
 */
export async function getInfraStatsFromDb(): Promise<InfraStats> {
  try {
    const now = new Date();

    const [
      apiKeysResult,
      chainsResult,
      chainsEnabledResult,
      walletsResult,
      walletsByProviderResult,
      sessionsResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(apiKeys),
      db.select({ count: count() }).from(chains),
      db
        .select({ count: count() })
        .from(chains)
        .where(eq(chains.isEnabled, true)),
      db
        .select({ count: count() })
        .from(paraWallets)
        .where(eq(paraWallets.isActive, true)),
      db
        .select({ provider: paraWallets.provider, count: count() })
        .from(paraWallets)
        .where(eq(paraWallets.isActive, true))
        .groupBy(paraWallets.provider),
      db
        .select({ count: count() })
        .from(sessions)
        .where(gte(sessions.expiresAt, now)),
    ]);

    const walletsByProvider = { para: 0, turnkey: 0 };
    for (const row of walletsByProviderResult) {
      if (row.provider === "para" || row.provider === "turnkey") {
        walletsByProvider[row.provider] = Number(row.count) || 0;
      }
    }

    return {
      apiKeysTotal: Number(apiKeysResult[0]?.count) || 0,
      chainsTotal: Number(chainsResult[0]?.count) || 0,
      chainsEnabled: Number(chainsEnabledResult[0]?.count) || 0,
      paraWalletsTotal: Number(walletsResult[0]?.count) || 0,
      walletsByProvider,
      sessionsActive: Number(sessionsResult[0]?.count) || 0,
    };
  } catch (error) {
    console.error("[Metrics] Failed to query infra stats from DB:", error);
    return {
      apiKeysTotal: 0,
      chainsTotal: 0,
      chainsEnabled: 0,
      paraWalletsTotal: 0,
      walletsByProvider: { para: 0, turnkey: 0 },
      sessionsActive: 0,
    };
  }
}

export type VoteStats = {
  totalVotes: number;
  totalUpvotes: number;
  totalDownvotes: number;
  topWorkflows: { workflowId: string; score: number }[];
  mostClonedWorkflows: {
    workflowId: string;
    cloneCount: number;
  }[];
  topVoters: { userId: string; voteCount: number }[];
};

export async function getVoteStatsFromDb(): Promise<VoteStats> {
  try {
    const [
      totalsResult,
      topWorkflowsResult,
      mostClonedResult,
      topVotersResult,
    ] = await Promise.all([
      db
        .select({
          totalVotes: count(),
          totalUpvotes: sql<string>`COUNT(*) FILTER (WHERE ${workflowRatings.rating} = 1)`,
          totalDownvotes: sql<string>`COUNT(*) FILTER (WHERE ${workflowRatings.rating} = -1)`,
        })
        .from(workflowRatings),
      db
        .select({
          workflowId: workflowRatings.workflowId,
          score: sql<string>`COALESCE(SUM(${workflowRatings.rating}), 0)`,
        })
        .from(workflowRatings)
        .groupBy(workflowRatings.workflowId)
        .orderBy(sql`SUM(${workflowRatings.rating}) DESC`)
        .limit(10),
      db
        .select({
          workflowId: workflows.sourceWorkflowId,
          cloneCount: count(),
        })
        .from(workflows)
        .where(sql`${workflows.sourceWorkflowId} IS NOT NULL`)
        .groupBy(workflows.sourceWorkflowId)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10),
      db
        .select({
          userId: workflowRatings.userId,
          voteCount: count(),
        })
        .from(workflowRatings)
        .groupBy(workflowRatings.userId)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10),
    ]);

    const totals = totalsResult[0];

    return {
      totalVotes: Number(totals?.totalVotes) || 0,
      totalUpvotes: Number(totals?.totalUpvotes) || 0,
      totalDownvotes: Number(totals?.totalDownvotes) || 0,
      topWorkflows: topWorkflowsResult.map((r) => ({
        workflowId: r.workflowId,
        score: Number(r.score),
      })),
      mostClonedWorkflows: mostClonedResult
        .filter((r) => r.workflowId !== null)
        .map((r) => ({
          workflowId: r.workflowId as string,
          cloneCount: Number(r.cloneCount),
        })),
      topVoters: topVotersResult.map((r) => ({
        userId: r.userId,
        voteCount: Number(r.voteCount),
      })),
    };
  } catch (error) {
    console.error("[Metrics] Failed to query vote stats from DB:", error);
    return {
      totalVotes: 0,
      totalUpvotes: 0,
      totalDownvotes: 0,
      topWorkflows: [],
      mostClonedWorkflows: [],
      topVoters: [],
    };
  }
}

/**
 * Query names of all enabled chains from the database.
 * Used to pre-initialize RPC metrics so every chain appears in Grafana.
 */
export async function getEnabledChainNamesFromDb(): Promise<string[]> {
  try {
    const results = await db
      .select({ name: chains.name })
      .from(chains)
      .where(eq(chains.isEnabled, true));

    return results.map((r) => r.name);
  } catch (error) {
    console.error("[Metrics] Failed to query enabled chain names:", error);
    return [];
  }
}

// Subscription statuses that count toward MRR — kept inline in the SQL
// query (active / trialing / past_due). Canceled / unpaid / paused
// subscriptions do not contribute.

export type BillingStats = {
  // Org count per (plan, tier, billing_status). One entry per unique
  // combination. tier is null for free and enterprise (no tier system).
  orgsByPlan: Array<{
    plan: PlanName;
    tier: TierKey | null;
    billingStatus: BillingStatus;
    count: number;
  }>;

  // Per-org execution counts. One entry per org (free + paid).
  orgsExecutions: Array<{
    orgSlug: string;
    plan: PlanName;
    exec30d: number;
    execMonth: number;
    // Monthly execution allowance for the org's tier, or -1 for unlimited
    // (enterprise) and 0 when not applicable.
    monthlyLimit: number;
  }>;

  // Approximate MRR in USD cents per (plan, tier), computed from
  // PLANS[plan].tiers[tier].monthlyPrice. Stripe remains the source of
  // truth for accounting.
  mrrCentsByPlan: Array<{
    plan: PlanName;
    tier: TierKey | null;
    cents: number;
  }>;

  // Total MRR in USD cents across all plans and tiers.
  mrrCentsTotal: number;
};

function emptyBillingStats(): BillingStats {
  return {
    orgsByPlan: [],
    orgsExecutions: [],
    mrrCentsByPlan: [],
    mrrCentsTotal: 0,
  };
}

function tierMonthlyPriceCents(plan: PlanName, tier: TierKey | null): number {
  if (!tier) {
    return 0;
  }
  const planDef = PLANS[plan];
  const found = planDef.tiers.find((t) => t.key === tier);
  return found ? Math.round(found.monthlyPrice * 100) : 0;
}

/**
 * Query billing-aware metrics from the database in a single pass.
 *
 * Joins workflow_executions -> workflows -> organization -> organization_subscriptions
 * to produce per-org execution counts (30-day rolling and current-month-to-date),
 * org distribution by plan/billing status, and a directional MRR figure.
 */
export async function getBillingStatsFromDb(): Promise<BillingStats> {
  try {
    // Aggregate counts: orgs by (plan, tier, billing_status). LEFT JOIN
    // handles legacy orgs without a subscription row (mapped to plan="free",
    // billing_status="none" via fallback in OrgListEntry parsing).
    const orgsByPlanResult = await db
      .select({
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        status: organizationSubscriptions.status,
        count: count(),
      })
      .from(organization)
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      )
      .groupBy(
        organizationSubscriptions.plan,
        organizationSubscriptions.tier,
        organizationSubscriptions.status
      );

    // Per-org executions in the last 30 days + current month. We compute
    // both windows in one query using FILTER clauses, then bucket free orgs
    // in JS to keep the SQL straightforward. Anonymous workflows (no
    // organization) are excluded — they're already covered by ANONYMOUS_ORG_SLUG
    // in the per-org error gauge.
    const execByOrgResult = await db
      .select({
        orgSlug: organization.slug,
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
        exec30d: count(),
        execMonth: sql<string>`COUNT(*) FILTER (WHERE ${workflowExecutions.startedAt} >= date_trunc('month', NOW()))`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .innerJoin(organization, eq(workflows.organizationId, organization.id))
      .leftJoin(
        organizationSubscriptions,
        eq(organizationSubscriptions.organizationId, organization.id)
      )
      .where(sql`${workflowExecutions.startedAt} >= NOW() - INTERVAL '30 days'`)
      .groupBy(
        organization.slug,
        organizationSubscriptions.plan,
        organizationSubscriptions.tier
      );

    // Active-subscription tier list for MRR computation. We include past_due
    // because those orgs are still on the plan; only canceled/unpaid/paused
    // are excluded.
    const mrrSubsResult = await db
      .select({
        plan: organizationSubscriptions.plan,
        tier: organizationSubscriptions.tier,
      })
      .from(organizationSubscriptions)
      .where(
        sql`${organizationSubscriptions.status} IN ('active', 'trialing', 'past_due')`
      );

    const stats = emptyBillingStats();

    // Tally orgs by plan + tier + billing_status
    for (const row of orgsByPlanResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const billingStatus: BillingStatus =
        row.status === null ? "none" : parseBillingStatus(row.status);
      const count = Number(row.count);
      const existing = stats.orgsByPlan.find(
        (e) =>
          e.plan === plan &&
          e.tier === tier &&
          e.billingStatus === billingStatus
      );
      if (existing) {
        existing.count += count;
      } else {
        stats.orgsByPlan.push({ plan, tier, billingStatus, count });
      }
    }

    // Tally per-org executions — one entry per org (free + paid)
    for (const row of execByOrgResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const exec30d = Number(row.exec30d) || 0;
      const execMonth = Number(row.execMonth) || 0;

      const monthlyLimit = PLANS[plan].features.maxExecutionsPerMonth;
      const tierLimit =
        tier === null
          ? monthlyLimit
          : (PLANS[plan].tiers.find((t) => t.key === tier)?.executions ??
            monthlyLimit);

      stats.orgsExecutions.push({
        orgSlug: row.orgSlug,
        plan,
        exec30d,
        execMonth,
        monthlyLimit: tierLimit,
      });
    }

    // Compute MRR per (plan, tier) from active subscriptions × tier price
    for (const row of mrrSubsResult) {
      const plan = parsePlanName(row.plan, "free");
      const tier = parseTierKey(row.tier);
      const cents = tierMonthlyPriceCents(plan, tier);
      const existing = stats.mrrCentsByPlan.find(
        (e) => e.plan === plan && e.tier === tier
      );
      if (existing) {
        existing.cents += cents;
      } else {
        stats.mrrCentsByPlan.push({ plan, tier, cents });
      }
      stats.mrrCentsTotal += cents;
    }

    return stats;
  } catch (error) {
    console.error("[Metrics] Failed to query billing stats from DB:", error);
    return emptyBillingStats();
  }
}

export type ProbeChainConfig = {
  chainId: number;
  name: string;
  chainType: string;
  defaultPrimaryRpc: string;
  defaultFallbackRpc: string | null;
};

/**
 * Query all enabled chain configs for the active RPC health probe.
 * Returns chain metadata + default RPC URLs for both primary and fallback.
 */
export async function getEnabledChainConfigsForProbe(): Promise<
  ProbeChainConfig[]
> {
  try {
    return await db
      .select({
        chainId: chains.chainId,
        name: chains.name,
        chainType: chains.chainType,
        defaultPrimaryRpc: chains.defaultPrimaryRpc,
        defaultFallbackRpc: chains.defaultFallbackRpc,
      })
      .from(chains)
      .where(eq(chains.isEnabled, true));
  } catch {
    return [];
  }
}
