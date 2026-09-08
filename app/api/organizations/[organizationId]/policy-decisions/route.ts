import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { organizationPolicies, policyDecisions } from "@/lib/db/schema";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { PolicyOutcome } from "@/lib/policy";
import { requireOrgPolicyAccess } from "../policies/_lib/access";

/**
 * The decision log.
 *
 * This is what makes monitor mode worth anything: it shows what a policy would
 * have blocked before anyone turns enforcement on, and afterwards it answers
 * "why did this stop" without reading execution logs.
 *
 * Unmanaged decisions are never written, so this is already the governed subset
 * rather than a firehose.
 */

const DEFAULT_LIMIT = 25;

/**
 * Decisions that no longer belong to a living policy.
 *
 * `governing_policy_ids` is a jsonb array rather than a foreign key, on purpose:
 * a decision is a historical record and deleting a policy must not erase the
 * evidence of what it did. The cost is that the reference can dangle, so this
 * predicate finds the rows whose every governing policy is gone, plus the
 * unmanaged ones that never had a policy at all.
 */
function orphanedPredicate() {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${organizationPolicies} p
    WHERE p.id IN (
      SELECT jsonb_array_elements_text(
        COALESCE(${policyDecisions.governingPolicyIds}, '[]'::jsonb)
      )
    )
  )`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  const url = new URL(request.url);
  const req = parsePageRequest(url, { fallback: DEFAULT_LIMIT });
  const outcome = url.searchParams.get("outcome");
  const policyId = url.searchParams.get("policyId");
  const orphaned = url.searchParams.get("orphaned") === "true";
  const query = url.searchParams.get("q")?.trim() ?? "";

  try {
    const conditions = [eq(policyDecisions.organizationId, organizationId)];
    if (outcome && Object.values(PolicyOutcome).includes(outcome as never)) {
      conditions.push(eq(policyDecisions.outcome, outcome as PolicyOutcome));
    }
    if (policyId) {
      conditions.push(
        sql`${policyDecisions.governingPolicyIds} @> ${JSON.stringify([policyId])}::jsonb`
      );
    }
    if (orphaned) {
      conditions.push(orphanedPredicate());
    }
    if (query) {
      const term = `%${query}%`;
      const match = or(
        ilike(policyDecisions.capability, term),
        ilike(policyDecisions.resource, term),
        ilike(policyDecisions.reason, term),
        ilike(policyDecisions.checkpoint, term),
        ilike(policyDecisions.outcome, term)
      );
      if (match) {
        conditions.push(match);
      }
    }

    const where = and(...conditions);

    const [rows, [totalRow]] = await Promise.all([
      db
        .select({
          id: policyDecisions.id,
          checkpoint: policyDecisions.checkpoint,
          capability: policyDecisions.capability,
          resource: policyDecisions.resource,
          outcome: policyDecisions.outcome,
          reason: policyDecisions.reason,
          matchedSids: policyDecisions.matchedSids,
          governingPolicyIds: policyDecisions.governingPolicyIds,
          observedOnly: policyDecisions.observedOnly,
          principalKind: policyDecisions.principalKind,
          executionId: policyDecisions.executionId,
          workflowId: policyDecisions.workflowId,
          createdAt: policyDecisions.createdAt,
        })
        .from(policyDecisions)
        .where(where)
        .orderBy(desc(policyDecisions.createdAt))
        .limit(req.pageSize)
        .offset(req.offset),
      db.select({ value: count() }).from(policyDecisions).where(where),
    ]);

    // An explicit projection rather than the whole row: the stored facts and
    // signals are for the engine, and this endpoint is read by anyone who can
    // see policy.
    return NextResponse.json(buildPage(rows, totalRow?.value ?? 0, req, url));
  } catch (error) {
    return apiError(error, "Failed to read policy decisions");
  }
}
