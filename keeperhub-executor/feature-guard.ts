import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { parsePlanName } from "../lib/billing/plans";
import { organizationSubscriptions } from "../lib/db/schema";
import {
  extractActionTypeNodes,
  validateWorkflowFeatures,
  type WorkflowFeatureViolation,
} from "../lib/features";

// Mirrors lib/features/route-guard.ts but without server-only / NextResponse so
// it can run in the standalone executor process. Trigger funnel for scheduler,
// block, and event services — blocking here defends all three at once.

export type FeatureGuardResult =
  | { allowed: true; reason: "billing_disabled" | "no_violations" }
  | {
      allowed: false;
      reason: "upgrade_required";
      violations: WorkflowFeatureViolation[];
    };

function isBillingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";
}

export async function checkWorkflowFeaturesForExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  organizationId: string | null | undefined,
  nodes: readonly unknown[]
): Promise<FeatureGuardResult> {
  if (!isBillingEnabled()) {
    return { allowed: true, reason: "billing_disabled" };
  }

  // Default-deny: when there's no org context (anonymous / system caller),
  // treat as free plan and run validation. A workflow with gated nodes must
  // never execute without a paid plan, regardless of how it got triggered.
  let plan: ReturnType<typeof parsePlanName> = "free";
  if (organizationId) {
    const [sub] = await db
      .select({ plan: organizationSubscriptions.plan })
      .from(organizationSubscriptions)
      .where(eq(organizationSubscriptions.organizationId, organizationId))
      .limit(1);
    plan = parsePlanName(sub?.plan);
  }

  const refs = extractActionTypeNodes(nodes);
  const violations = validateWorkflowFeatures(refs, plan);

  if (violations.length === 0) {
    return { allowed: true, reason: "no_violations" };
  }

  return { allowed: false, reason: "upgrade_required", violations };
}
