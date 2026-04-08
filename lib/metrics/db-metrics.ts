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
import { db } from "@/lib/db";
import {
  apiKeys,
  chains,
  integrations,
  invitation,
  member,
  organization,
  paraWallets,
  sessions,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";

// Histogram bucket boundaries in milliseconds (must match prometheus.ts)
const WORKFLOW_DURATION_BUCKETS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 30_000,
];
const STEP_DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000];

export type WorkflowStats = {
  // Total executions by status
  totalSuccess: number;
  totalError: number;
  totalRunning: number;
  totalPending: number;
  totalCancelled: number;

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
    // Query execution counts by status
    const statusCounts = await db
      .select({
        status: workflowExecutions.status,
        count: count(),
      })
      .from(workflowExecutions)
      .groupBy(workflowExecutions.status);

    const stats: WorkflowStats = {
      totalSuccess: 0,
      totalError: 0,
      totalRunning: 0,
      totalPending: 0,
      totalCancelled: 0,
      durationBuckets: new Array(WORKFLOW_DURATION_BUCKETS.length + 1).fill(0),
      durationSum: 0,
      durationCount: 0,
    };

    for (const row of statusCounts) {
      switch (row.status) {
        case "success":
          stats.totalSuccess = row.count;
          break;
        case "error":
          stats.totalError = row.count;
          break;
        case "running":
          stats.totalRunning = row.count;
          break;
        case "pending":
          stats.totalPending = row.count;
          break;
        case "cancelled":
          stats.totalCancelled = row.count;
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
};

export async function getOrgListFromDb(): Promise<OrgListEntry[]> {
  try {
    const result = await db
      .select({
        name: organization.name,
        slug: organization.slug,
      })
      .from(organization);

    return result.map((row) => ({
      name: row.name,
      slug: row.slug,
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
  paraWalletsTotal: number;
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
      sessionsResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(apiKeys),
      db.select({ count: count() }).from(chains),
      db
        .select({ count: count() })
        .from(chains)
        .where(eq(chains.isEnabled, true)),
      db.select({ count: count() }).from(paraWallets),
      db
        .select({ count: count() })
        .from(sessions)
        .where(gte(sessions.expiresAt, now)),
    ]);

    return {
      apiKeysTotal: Number(apiKeysResult[0]?.count) || 0,
      chainsTotal: Number(chainsResult[0]?.count) || 0,
      chainsEnabled: Number(chainsEnabledResult[0]?.count) || 0,
      paraWalletsTotal: Number(walletsResult[0]?.count) || 0,
      sessionsActive: Number(sessionsResult[0]?.count) || 0,
    };
  } catch (error) {
    console.error("[Metrics] Failed to query infra stats from DB:", error);
    return {
      apiKeysTotal: 0,
      chainsTotal: 0,
      chainsEnabled: 0,
      paraWalletsTotal: 0,
      sessionsActive: 0,
    };
  }
}
