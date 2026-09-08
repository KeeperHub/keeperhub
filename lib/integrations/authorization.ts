import "server-only";

import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type IntegrationVisibility,
  integrations,
  users,
} from "@/lib/db/schema";

/**
 * The identity whose grants gate credential use for a given execution.
 *
 * The ORG principal (`organizationId` set) is the workflow's owning
 * organization itself. The org owns workflows, so every execution gate and
 * the runtime credential fetch authorize as the org - a workflow uses its
 * org's organization-visibility integrations regardless of who created it or
 * who triggered the run. Private integrations and per-user specific_members
 * grants do NOT resolve for the org principal.
 */
export type IntegrationPrincipal = {
  organizationId: string | null;
};

/** Minimal integration shape needed to make an authorization decision. */
export type IntegrationAuthRow = {
  id: string;
  createdBy: string;
  organizationId: string | null;
  visibility: IntegrationVisibility;
};

type AuthContext = {
  /** Owner of the integration is deactivated - credentials are frozen. */
  isOwnerDeactivated: boolean;
};

/**
 * Pure authorization decision for a single (integration, principal) pair.
 * No I/O - the caller resolves the AuthContext via batched queries. Kept pure
 * so the rule table is unit-testable without a database.
 */
export function isIntegrationUsable(
  integration: IntegrationAuthRow,
  principal: IntegrationPrincipal,
  ctx: AuthContext
): boolean {
  // A deactivated creator's credentials are frozen for everyone. Deactivation
  // (compromise/offboard) must freeze them even though the org owns the
  // workflows that reference them.
  if (ctx.isOwnerDeactivated) {
    return false;
  }

  switch (integration.visibility) {
    case "organization":
      return (
        integration.organizationId !== null &&
        integration.organizationId === principal.organizationId
      );
    case "specific_members":
      // Per-user grants do not resolve for the org principal.
      return false;
    default:
      // "private" - personal credentials never resolve for the org principal.
      return false;
  }
}

/**
 * Given a set of integration ids and the executing principal, return the
 * subset the principal is NOT authorized to use.
 *
 * Non-existent ids (e.g. deleted integrations) are treated as authorized -
 * stale references must stay savable and must not leak existence. Owner
 * deactivation is batched into a single query to avoid N+1.
 */
export async function filterUnauthorizedIntegrationIds(
  integrationIds: string[],
  principal: IntegrationPrincipal
): Promise<string[]> {
  if (integrationIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      id: integrations.id,
      createdBy: integrations.createdBy,
      organizationId: integrations.organizationId,
      visibility: integrations.visibility,
    })
    .from(integrations)
    .where(inArray(integrations.id, integrationIds));

  if (rows.length === 0) {
    return [];
  }

  const creatorIds = [...new Set(rows.map((row) => row.createdBy))];
  const deactivatedOwners = new Set<string>();
  const deactivatedRows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, creatorIds), isNotNull(users.deactivatedAt)));
  for (const user of deactivatedRows) {
    deactivatedOwners.add(user.id);
  }

  const unauthorized: string[] = [];
  for (const row of rows) {
    const usable = isIntegrationUsable(row, principal, {
      isOwnerDeactivated: deactivatedOwners.has(row.createdBy),
    });
    if (!usable) {
      unauthorized.push(row.id);
    }
  }
  return unauthorized;
}
