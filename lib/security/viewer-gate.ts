import { and, eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { isViewerRole, VIEWER_ROLE } from "@/lib/organization/role-label";
import { getOrgRole } from "@/lib/security/org-role";
import { orgIdFromPath } from "@/lib/security/viewer-policy";

const ORG_HEADER = "x-organization-id";

async function roleInOrgByIdOrSlug(
  userId: string,
  idOrSlug: string
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.userId, userId),
        or(eq(organization.id, idOrSlug), eq(organization.slug, idOrSlug))
      )
    )
    .limit(1);
  return row?.role ?? null;
}

async function isViewerAnywhere(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.role, VIEWER_ROLE)))
    .limit(1);
  return row !== undefined;
}

/**
 * True when the session caller is a viewer in the organization this request
 * acts on. The organization is resolved the way route handlers resolve it: an
 * /api/organizations/<id>/ path segment, then the X-Organization-Id header,
 * then the session's active organization. With none of those, a viewer
 * membership anywhere blocks the call, so an unresolved org fails closed.
 */
export async function isViewerForRequest(
  request: Request,
  userId: string,
  activeOrganizationId: string | null | undefined
): Promise<boolean> {
  const pathOrgId = orgIdFromPath(new URL(request.url).pathname);
  if (pathOrgId) {
    return isViewerRole(await getOrgRole(userId, pathOrgId));
  }
  const headerOrg = request.headers.get(ORG_HEADER)?.trim();
  if (headerOrg) {
    return isViewerRole(await roleInOrgByIdOrSlug(userId, headerOrg));
  }
  if (activeOrganizationId) {
    return isViewerRole(await getOrgRole(userId, activeOrganizationId));
  }
  return await isViewerAnywhere(userId);
}
