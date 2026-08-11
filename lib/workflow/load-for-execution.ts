import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { getWorkflowExecutability } from "@/lib/workflow/executable";

export type LoadWorkflowForExecutionResult =
  | { status: "not_found" }
  | {
      status: "not_executable";
      reason: "deleted" | "deactivated" | "org_deactivated" | "disabled";
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
      organizationName: organization.name,
    })
    .from(workflows)
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .where(eq(workflows.id, id))
    .limit(1);

  if (!row?.workflow) {
    return { status: "not_found" };
  }

  const executability = getWorkflowExecutability({
    enabled: row.workflow.enabled,
    deletedAt: row.workflow.deletedAt,
    deactivatedAt: row.workflow.deactivatedAt,
    orgDeactivatedAt: row.orgDeactivatedAt ?? null,
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
