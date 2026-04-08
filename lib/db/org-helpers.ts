/**
 * Helpers for resolving organization metadata used in error logs.
 */
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { enterWorkflowErrorContext } from "@/lib/workflow-error-context";

/**
 * Resolve an organization's slug by id. Cached per request via React `cache()`
 * so multiple call sites in the same request share a single round-trip.
 */
export const getOrgSlug = cache(
  async (orgId: string | null | undefined): Promise<string | undefined> => {
    if (!orgId) {
      return undefined;
    }
    try {
      const rows = await db
        .select({ slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);
      return rows[0]?.slug ?? undefined;
    } catch {
      // Slug is best-effort metadata for log labels - never let a failed
      // lookup break the calling request.
      return undefined;
    }
  }
);

/**
 * Convenience for direct-execute API routes (e.g.
 * /api/execute/check-and-execute) that bypass the workflow executor and
 * therefore don't get its ALS scope. Resolves the org slug and enters the
 * workflow error context for the rest of the request.
 */
export async function enterApiExecuteErrorContext(
  organizationId: string | null | undefined
): Promise<void> {
  if (!organizationId) {
    return;
  }
  const slug = await getOrgSlug(organizationId);
  enterWorkflowErrorContext({
    org_id: organizationId,
    org_slug: slug,
  });
}
