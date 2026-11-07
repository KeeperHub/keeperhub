import { NextResponse } from "next/server";
import { resolveSessionOrg } from "@/lib/middleware/auth-helpers";
import { isViewerRole } from "@/lib/organization/role-label";
import { getOrgRole } from "@/lib/security/org-role";
import {
  orgIdFromPath,
  VIEWER_READ_ONLY_ERROR,
} from "@/lib/security/viewer-policy";

const ORG_HEADER = "x-organization-id";

/**
 * True when the session caller is a viewer in the organization this request
 * acts on. An /api/organizations/<id>/ path segment wins; otherwise the org is
 * resolved with resolveSessionOrg, the same resolver the routes use (the
 * X-Organization-Id header, then the active org, then the first membership).
 *
 * When an X-Organization-Id header is sent, the active org is checked too:
 * routes that read the org from the session ignore the header, so a viewer in
 * the active org must not get through by naming a different org.
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
  const resolved = await resolveSessionOrg(
    request,
    userId,
    activeOrganizationId ?? null
  );
  if (!("error" in resolved) && isViewerRole(resolved.role)) {
    return true;
  }
  const sentHeader = request.headers.has(ORG_HEADER);
  if (activeOrganizationId && (sentHeader || "error" in resolved)) {
    return isViewerRole(await getOrgRole(userId, activeOrganizationId));
  }
  return false;
}

/**
 * Route-level guard for handlers that resolve the session themselves rather
 * than through the shared auth helpers. Returns a 403 for a viewer, else null.
 */
export async function viewerForbidden(
  userId: string,
  organizationId: string | null | undefined
): Promise<NextResponse | null> {
  if (!organizationId) {
    return null;
  }
  if (!isViewerRole(await getOrgRole(userId, organizationId))) {
    return null;
  }
  return NextResponse.json(VIEWER_READ_ONLY_ERROR, { status: 403 });
}
