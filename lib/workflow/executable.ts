import { and, eq, isNull, type SQL } from "drizzle-orm";
import { organization, workflows } from "@/lib/db/schema";
import { workflowNotDeleted } from "@/lib/workflow/soft-delete";

/**
 * The single source of truth for "is this workflow live enough to run". A
 * workflow is executable only when it is enabled, not soft-deleted, not
 * deactivated, and its owning organization is not deactivated. All five
 * execution entry points (scheduler select, executor dispatch, HTTP execute,
 * webhook, agent-call lookup) must gate on this so they cannot drift apart.
 *
 * Ownership lives on the ORGANIZATION, not the creating user: `workflows.userId`
 * is createdBy (audit only) and is never an execution-authority signal. Owner
 * deactivation is handled at the org level - deactivating an org owner cascades
 * to `organization.deactivated_at` (when no active owner remains), which this
 * predicate honors.
 *
 * Two shapes are exported because the entry points come in two flavours:
 * - SELECT sites compose `workflowExecutableConditions()` into their WHERE.
 * - fetch-then-gate sites call `getWorkflowExecutability()` on a loaded row.
 * Both encode the same columns, in one file, so they stay in lockstep.
 *
 * This module must stay free of `@/lib/db` and `server-only` imports: the
 * standalone executor imports it via a relative path and `getWorkflowExecutability`
 * may reach client bundles. Org deactivation is loaded by each call site with
 * its own db handle, never here.
 */

/**
 * Drizzle WHERE fragment for "exists and is not gone": not soft-deleted, not
 * deactivated, and owned by an active org, but WITHOUT the `enabled` clause.
 * Used by the agent-call lookup, which surfaces a listed-but-disabled workflow
 * as "temporarily unavailable" rather than 404, so it gates `enabled` in-memory
 * after the row loads.
 *
 * REQUIRED: the caller's query MUST join `organization` on
 * `workflows.organizationId` before composing this fragment. An inner join is
 * safe because `workflows.organizationId` is NOT NULL. Omitting the join
 * produces a runtime SQL error ("missing FROM-clause entry for table
 * 'organization'"). If you cannot add the join, use `getWorkflowExecutability()`
 * on the loaded row instead.
 */
export function workflowReachableConditions(): SQL {
  return and(
    workflowNotDeleted(),
    isNull(workflows.deactivatedAt),
    isNull(organization.deactivatedAt)
  ) as SQL;
}

/**
 * Drizzle WHERE fragment for the fully-runnable SELECT sites (scheduler select):
 * reachable AND enabled. Carries the same join requirement as
 * `workflowReachableConditions` - the caller MUST join `organization`.
 */
export function workflowExecutableConditions(): SQL {
  return and(eq(workflows.enabled, true), workflowReachableConditions()) as SQL;
}

export type WorkflowExecutabilityInput = {
  enabled: boolean;
  // `?? null` coercion below treats an absent timestamp as "not set". Mirrors
  // getWorkflowAccess, which fields the same trimmed shapes some callers pass.
  deletedAt?: Date | null;
  // The workflow's own deactivation timestamp. A deactivated workflow is fully
  // off: it cannot be enabled or triggered manually. Distinct from `enabled`,
  // which only gates automated dispatch and still permits a manual editor run.
  deactivatedAt?: Date | null;
  // The owning org's deactivation timestamp. Org is the owner, so this is the
  // owner-deactivation gate (the creator user is not an authority).
  orgDeactivatedAt?: Date | null;
};

export type WorkflowExecutability =
  | { executable: true }
  | {
      executable: false;
      reason: "deleted" | "deactivated" | "org_deactivated" | "disabled";
    };

/**
 * In-memory gate for the fetch-then-gate sites. The reason lets callers map to
 * their existing HTTP semantics (the webhook surfaces "disabled" as 410 and
 * everything else as 404). Precedence is fixed here - deleted, then the two
 * "fully off" deactivation states, then disabled.
 *
 * `deactivated` and `org_deactivated` rank ABOVE `disabled` on purpose: a
 * workflow can be both deactivated and disabled, and the manual-execute path
 * lets `disabled` through (a disabled workflow is still runnable from the
 * editor) while a deactivated one must be blocked. Reporting the stronger
 * reason keeps that block intact. `deleted` still wins overall because a
 * soft-deleted workflow can still be enabled (`softDeleteValues()` clears
 * `isListed` but not `enabled`) and "gone" is the most accurate signal.
 */
export function getWorkflowExecutability(
  workflow: WorkflowExecutabilityInput
): WorkflowExecutability {
  if ((workflow.deletedAt ?? null) !== null) {
    return { executable: false, reason: "deleted" };
  }
  if ((workflow.deactivatedAt ?? null) !== null) {
    return { executable: false, reason: "deactivated" };
  }
  if ((workflow.orgDeactivatedAt ?? null) !== null) {
    return { executable: false, reason: "org_deactivated" };
  }
  if (!workflow.enabled) {
    return { executable: false, reason: "disabled" };
  }
  return { executable: true };
}
