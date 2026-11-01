import { eq } from "drizzle-orm";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { organization, users, workflows } from "@/lib/db/schema";
import { getWorkflowExecutability } from "@/lib/workflow/executable";

export type LoadWorkflowForExecutionResult =
  | { status: "not_found" }
  | {
      status: "not_executable";
      reason:
        | "deleted"
        | "deactivated"
        | "org_deactivated"
        | "halted"
        | "disabled"
        | "anonymous_owner";
    }
  | {
      status: "ok";
      workflow: typeof workflows.$inferSelect;
      organizationName: string | undefined;
    };

/**
 * Load a workflow by id and evaluate its lifecycle state in a single round-trip.
 * Replaces the repeated pattern of findFirst + separate org-deactivation join +
 * getWorkflowExecutability() that each entry point re-implemented independently.
 *
 * `requireEnabled: true` — blocks disabled workflows (automated triggers: webhook,
 * executor). `requireEnabled: false` — lets disabled through (interactive execute
 * route, where the editor "Run" button must still work on not-yet-enabled workflows).
 *
 * Uses @/lib/db internally (same pattern as validateWorkflowIntegrations, which
 * the executor already imports). Safe to call from both Next.js routes and the
 * standalone executor process.
 */
export async function loadWorkflowForExecution(
  id: string,
  opts: { requireEnabled: boolean }
): Promise<LoadWorkflowForExecutionResult> {
  const [row] = await db
    .select({
      workflow: workflows,
      orgDeactivatedAt: organization.deactivatedAt,
      orgHaltedAt: organization.haltedAt,
      organizationName: organization.name,
      ownerIsAnonymous: users.isAnonymous,
      ownerEmail: users.email,
      ownerName: users.name,
    })
    .from(workflows)
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .leftJoin(users, eq(users.id, workflows.userId))
    .where(eq(workflows.id, id))
    .limit(1);

  if (!row?.workflow) {
    return { status: "not_found" };
  }

  // Anonymous accounts may build but never run, whatever the trigger.
  if (
    isAnonymousUserShape({
      isAnonymous: row.ownerIsAnonymous,
      email: row.ownerEmail,
      name: row.ownerName,
    })
  ) {
    return { status: "not_executable", reason: "anonymous_owner" };
  }

  const executability = getWorkflowExecutability({
    enabled: row.workflow.enabled,
    deletedAt: row.workflow.deletedAt,
    deactivatedAt: row.workflow.deactivatedAt,
    orgDeactivatedAt: row.orgDeactivatedAt ?? null,
    orgHaltedAt: row.orgHaltedAt ?? null,
  });

  if (!executability.executable) {
    if (!opts.requireEnabled && executability.reason === "disabled") {
      return {
        status: "ok",
        workflow: row.workflow,
        organizationName: row.organizationName ?? undefined,
      };
    }
    return { status: "not_executable", reason: executability.reason };
  }

  return {
    status: "ok",
    workflow: row.workflow,
    organizationName: row.organizationName ?? undefined,
  };
}
