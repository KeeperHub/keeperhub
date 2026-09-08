import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization, workflows } from "@/lib/db/schema";
import { resolveOrgSlugCached } from "@/lib/metrics/org-slug-cache";

/**
 * Resolve the org slug that owns the workflow behind an execution, falling
 * back to ANONYMOUS_ORG_SLUG for personal/anonymous workflows so counters
 * always emit a series (the SLA alert filters by `org_slug=~`). Memoized per
 * workflowId for the pod lifetime; see org-slug-cache.ts for the trade-offs.
 */
export function resolveOrgSlugForCounter(workflowId: string): Promise<string> {
  return resolveOrgSlugCached(workflowId, (id) =>
    db
      .select({ slug: organization.slug })
      .from(workflows)
      .leftJoin(organization, eq(workflows.organizationId, organization.id))
      .where(eq(workflows.id, id))
      .limit(1)
  );
}
