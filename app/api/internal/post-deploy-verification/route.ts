/**
 * Post-deployment verification for managed and enterprise organizations.
 *
 * Reads recent workflow execution outcomes for the white-glove cohort (the
 * env-sourced managed slugs from getManagedOrgSlugs() plus any org on an
 * `enterprise` subscription) and reports whether any of them regressed after a
 * deploy. Authenticated as an internal service (HMAC) and invoked from the
 * post-deploy-verification CI job, which runs inside the cluster against the
 * in-pod service URL (the public hostname is WAF-blocked for /api/internal/*).
 *
 * On a flagged org this pages that client's own PagerDuty service (per-client
 * routing key, env sourced), deduped to one incident per org per deploy.
 *
 * The cohort is gated to orgs that actually have work due in the window: an
 * enabled, non-deleted, non-deactivated workflow with an enabled schedule whose
 * next run falls inside [`since`, `until`]. Idle orgs (no live workflow, or
 * schedules that won't fire in the window) are excluded so a deploy is not
 * judged against orgs that were never going to run. Execution counting covers
 * every trigger type (scheduled, block, webhook, event, manual).
 *
 * An org is flagged as a problem when:
 *   - it produced any `system_error` executions in the window (platform/infra
 *     faults are the strongest signal of a deploy regression), OR
 *   - it ran at least `minExecutions` and its error rate exceeds `maxErrorRate`.
 *
 * This is a stateless single check (one query per request); the CI job owns the
 * timing and polls it. Window and thresholds are query-param overridable so the
 * job can tune them without a redeploy: `since`/`until` (unix seconds, the
 * window bounds), `lookbackMinutes` (fallback when `since`/`until` are absent),
 * `minExecutions`, and `maxErrorRate`.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  type PagerDutySeverity,
  triggerPagerDutyAlert,
} from "@/lib/alerting/pagerduty";
import { db } from "@/lib/db";
import {
  organization,
  organizationSubscriptions,
  workflowExecutions,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import { ERROR_STATUSES } from "@/lib/errors/execution-status";
import { HttpStatus } from "@/lib/http-status";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  getManagedOrgSlugs,
  getPagerDutyRoutingKey,
} from "@/lib/orgs/managed-clients";

const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_MIN_EXECUTIONS = 1;
const DEFAULT_MAX_ERROR_RATE = 0.5;
const SAMPLE_ERRORS_PER_ORG = 3;
const MAX_SAMPLE_ERROR_LENGTH = 300;
const PAGERDUTY_SOURCE = "post-deploy-verification";

// Internal P-levels. A missed execution or a platform (system_error) fault is a
// P2 (a managed/enterprise client's automation silently broke); a user-error
// rate spike is a P3 (more likely the client's own input/config than the
// deploy). PagerDuty severity: P2 -> critical, P3 -> warning.
type AlertSeverity = "P2" | "P3";

function pagerDutySeverity(severity: AlertSeverity): PagerDutySeverity {
  return severity === "P2" ? "critical" : "warning";
}

type TargetOrg = {
  id: string;
  slug: string;
  name: string;
  plan: string;
};

type OrgVerification = {
  organizationId: string;
  slug: string;
  name: string;
  plan: string;
  total: number;
  success: number;
  userErrors: number;
  systemErrors: number;
  errorRate: number;
  isProblem: boolean;
  severity: AlertSeverity | null;
  reasons: string[];
  sampleErrors: string[];
};

function parseNumberParam(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function resolveTargetOrgs(
  windowStart: Date,
  windowEnd: Date
): Promise<TargetOrg[]> {
  // Only verify orgs that actually have something due to run during the
  // monitoring window: an enabled, non-deleted, non-deactivated workflow with
  // an enabled schedule whose next run lands inside [windowStart, windowEnd].
  // Without this an idle org (no live workflow, or schedules that won't fire in
  // our window) is either dead weight or a false-positive source.
  //
  // Cohort = managed slugs (env-sourced) plus any enterprise-plan org. When no
  // managed slugs are configured we fall back to enterprise-plan orgs only.
  const managedSlugs = getManagedOrgSlugs();
  const rows = await db
    .selectDistinct({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      plan: organizationSubscriptions.plan,
    })
    .from(organization)
    .leftJoin(
      organizationSubscriptions,
      eq(organizationSubscriptions.organizationId, organization.id)
    )
    .innerJoin(workflows, eq(workflows.organizationId, organization.id))
    .innerJoin(
      workflowSchedules,
      eq(workflowSchedules.workflowId, workflows.id)
    )
    .where(
      and(
        isNull(organization.deactivatedAt),
        managedSlugs.length > 0
          ? or(
              inArray(organization.slug, managedSlugs),
              eq(organizationSubscriptions.plan, "enterprise")
            )
          : eq(organizationSubscriptions.plan, "enterprise"),
        eq(workflows.enabled, true),
        isNull(workflows.deletedAt),
        isNull(workflows.deactivatedAt),
        eq(workflowSchedules.enabled, true),
        gte(workflowSchedules.nextRunAt, windowStart),
        lte(workflowSchedules.nextRunAt, windowEnd)
      )
    );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan ?? "free",
  }));
}

async function fetchSampleErrors(
  problemOrgIds: string[],
  since: Date
): Promise<Map<string, string[]>> {
  const byOrg = new Map<string, string[]>();
  if (problemOrgIds.length === 0) {
    return byOrg;
  }

  const rows = await db
    .select({
      organizationId: workflows.organizationId,
      error: workflowExecutions.error,
      status: workflowExecutions.status,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(
      and(
        inArray(workflows.organizationId, problemOrgIds),
        gte(workflowExecutions.startedAt, since),
        inArray(workflowExecutions.status, [...ERROR_STATUSES])
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(problemOrgIds.length * SAMPLE_ERRORS_PER_ORG * 4);

  for (const row of rows) {
    const orgId = row.organizationId;
    if (!orgId) {
      continue;
    }
    const existing = byOrg.get(orgId) ?? [];
    if (existing.length >= SAMPLE_ERRORS_PER_ORG) {
      continue;
    }
    const message = (row.error ?? "(no error message)").slice(
      0,
      MAX_SAMPLE_ERROR_LENGTH
    );
    existing.push(`[${row.status}] ${message}`);
    byOrg.set(orgId, existing);
  }

  return byOrg;
}

/**
 * Page each flagged org's own PagerDuty service (per-client routing key, env
 * sourced). The dedup key is per (deploy, org) so the verification poll loop
 * collapses into one incident per org per deploy. Orgs without a routing key
 * (and no default) are skipped -- they still surface in the response + Loki.
 */
async function pageProblemOrgs(
  problems: OrgVerification[],
  deployId: string,
  windowStart: string
): Promise<void> {
  await Promise.all(
    problems.map((org) => {
      const routingKey = getPagerDutyRoutingKey(org.slug);
      if (!(routingKey && org.severity)) {
        return Promise.resolve(false);
      }
      return triggerPagerDutyAlert({
        routingKey,
        dedupKey: `post-deploy/${deployId || windowStart}/${org.organizationId}`,
        severity: pagerDutySeverity(org.severity),
        source: PAGERDUTY_SOURCE,
        summary: `[${org.severity}] Post-deploy regression for ${org.slug}: ${org.reasons.join("; ")}`,
        customDetails: {
          org_slug: org.slug,
          org_name: org.name,
          plan: org.plan,
          total: org.total,
          user_errors: org.userErrors,
          system_errors: org.systemErrors,
          reasons: org.reasons,
          sample_errors: org.sampleErrors,
          window_start: windowStart,
        },
      });
    })
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const url = new URL(request.url);
  const lookbackMinutes = parseNumberParam(
    url.searchParams.get("lookbackMinutes"),
    DEFAULT_LOOKBACK_MINUTES
  );
  const minExecutions = parseNumberParam(
    url.searchParams.get("minExecutions"),
    DEFAULT_MIN_EXECUTIONS
  );
  const maxErrorRate = parseNumberParam(
    url.searchParams.get("maxErrorRate"),
    DEFAULT_MAX_ERROR_RATE
  );

  // `final=1` on the CI loop's last poll: only then can "no executions in the
  // window" be concluded (a due schedule may fire at the very end of the
  // window). `deployId` (commit SHA) scopes the PagerDuty dedup key so all
  // polls of one deploy collapse into a single incident per org.
  const isFinalPoll =
    url.searchParams.get("final") === "1" ||
    url.searchParams.get("final") === "true";
  const deployId = url.searchParams.get("deployId") ?? "";

  // Stateless single check: one query per request. The CI job owns the timing
  // (it polls this endpoint). `since`/`until` (unix seconds) bound the
  // monitoring window the caller is watching: executions are counted from
  // `since` (so a poll sees only runs on the new build), and the cohort is
  // gated to orgs with a schedule firing within [`since`, `until`]. Both fall
  // back to the backward lookback window when omitted.
  const sinceParam = url.searchParams.get("since");
  const sinceEpoch = sinceParam ? Number.parseInt(sinceParam, 10) : Number.NaN;
  const since = Number.isFinite(sinceEpoch)
    ? new Date(sinceEpoch * 1000)
    : new Date(Date.now() - lookbackMinutes * 60 * 1000);

  const untilParam = url.searchParams.get("until");
  const untilEpoch = untilParam ? Number.parseInt(untilParam, 10) : Number.NaN;
  const until = Number.isFinite(untilEpoch)
    ? new Date(untilEpoch * 1000)
    : new Date(since.getTime() + lookbackMinutes * 60 * 1000);

  try {
    const windowStart = since.toISOString();
    const windowEnd = until.toISOString();
    const targetOrgs = await resolveTargetOrgs(since, until);

    if (targetOrgs.length === 0) {
      return NextResponse.json({
        ok: true,
        windowStart,
        windowEnd,
        minExecutions,
        maxErrorRate,
        checkedOrgs: 0,
        problemCount: 0,
        totalExecutions: 0,
        orgs: [],
        problems: [],
        generatedAt: new Date().toISOString(),
      });
    }

    const orgIds = targetOrgs.map((org) => org.id);
    const statsRows = await db
      .select({
        organizationId: workflows.organizationId,
        total: sql<number>`COUNT(*)`,
        success: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'success')`,
        userErrors: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'error')`,
        systemErrors: sql<number>`COUNT(*) FILTER (WHERE ${workflowExecutions.status} = 'system_error')`,
      })
      .from(workflowExecutions)
      .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
      .where(
        and(
          inArray(workflows.organizationId, orgIds),
          gte(workflowExecutions.startedAt, since)
        )
      )
      .groupBy(workflows.organizationId);

    const statsByOrg = new Map(
      statsRows.map((row) => [
        row.organizationId,
        {
          total: Number(row.total),
          success: Number(row.success),
          userErrors: Number(row.userErrors),
          systemErrors: Number(row.systemErrors),
        },
      ])
    );

    const orgs: OrgVerification[] = targetOrgs.map((org) => {
      const stats = statsByOrg.get(org.id) ?? {
        total: 0,
        success: 0,
        userErrors: 0,
        systemErrors: 0,
      };
      const errorCount = stats.userErrors + stats.systemErrors;
      const errorRate = stats.total > 0 ? errorCount / stats.total : 0;

      const reasons: string[] = [];
      let severity: AlertSeverity | null = null;

      // No executions: the org had a schedule due in the window but produced
      // nothing -- its automation silently did not run. Only conclusive on the
      // final poll. P2.
      if (isFinalPoll && stats.total === 0) {
        reasons.push("no executions in the monitoring window");
        severity = "P2";
      }
      // Platform/infra faults are the strongest signal of a deploy regression. P2.
      if (stats.systemErrors > 0) {
        reasons.push(`${stats.systemErrors} system_error execution(s)`);
        severity = "P2";
      }
      // User-error rate spike: more likely the client's own input/config than
      // the deploy. P3, and never downgrades an already-P2 org.
      if (stats.total >= minExecutions && errorRate > maxErrorRate) {
        reasons.push(
          `error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(
            maxErrorRate * 100
          ).toFixed(1)}% over ${stats.total} execution(s)`
        );
        severity = severity ?? "P3";
      }

      return {
        organizationId: org.id,
        slug: org.slug,
        name: org.name,
        plan: org.plan,
        total: stats.total,
        success: stats.success,
        userErrors: stats.userErrors,
        systemErrors: stats.systemErrors,
        errorRate,
        isProblem: reasons.length > 0,
        severity,
        reasons,
        sampleErrors: [],
      };
    });

    const problemOrgIds = orgs
      .filter((org) => org.isProblem)
      .map((org) => org.organizationId);
    const sampleErrors = await fetchSampleErrors(problemOrgIds, since);
    for (const org of orgs) {
      if (org.isProblem) {
        org.sampleErrors = sampleErrors.get(org.organizationId) ?? [];
      }
    }

    const problems = orgs.filter((org) => org.isProblem);
    const totalExecutions = orgs.reduce((sum, org) => sum + org.total, 0);

    // The per-org detail (slugs, names, sample error text) is customer data and
    // must not surface in the public-repo CI logs or an external Discord channel.
    // Emit it to internal observability (Loki) instead, where operators look up
    // specifics; the CI job only ever reports aggregate counts.
    if (problems.length > 0) {
      logSystemWarn(
        ErrorCategory.WORKFLOW_ENGINE,
        "Post-deploy verification flagged managed/enterprise org errors",
        undefined,
        {
          problem_count: String(problems.length),
          checked_orgs: String(orgs.length),
          window_start: windowStart,
          problems: JSON.stringify(
            problems.map((org) => ({
              slug: org.slug,
              plan: org.plan,
              total: org.total,
              userErrors: org.userErrors,
              systemErrors: org.systemErrors,
              reasons: org.reasons,
              sampleErrors: org.sampleErrors,
            }))
          ),
        }
      );

      // Page each flagged org's PagerDuty service. Never throws; a paging
      // failure is logged but does not fail the verification response.
      await pageProblemOrgs(problems, deployId, windowStart);
    }

    return NextResponse.json({
      ok: problems.length === 0,
      windowStart,
      windowEnd,
      minExecutions,
      maxErrorRate,
      checkedOrgs: orgs.length,
      problemCount: problems.length,
      totalExecutions,
      orgs,
      problems,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to run post-deploy verification",
      error,
      { endpoint: "/api/internal/post-deploy-verification", operation: "get" }
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to run post-deploy verification",
      },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
