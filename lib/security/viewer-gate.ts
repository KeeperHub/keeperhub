import { ORG_HEADER, resolveSessionOrg } from "@/lib/middleware/auth-helpers";
import { isViewerRole } from "@/lib/organization/role-label";
import { getOrgRole } from "@/lib/security/org-role";
import { orgIdFromPath } from "@/lib/security/viewer-policy";

// Every state-changing session request passes the gate, so its answer is
// cached briefly per caller and target. A role change reaches the gate within
// the TTL; the routes' own role checks apply it immediately.
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 10_000;
const cache = new Map<string, { isViewer: boolean; expiresAt: number }>();

function cacheGet(key: string): boolean | undefined {
  const hit = cache.get(key);
  if (!hit) {
    return;
  }
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return;
  }
  return hit.isViewer;
}

function cacheSet(key: string, isViewer: boolean): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, { isViewer, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function resolveIsViewer(
  request: Request,
  userId: string,
  pathOrgId: string | null,
  activeOrganizationId: string | null
): Promise<boolean> {
  if (pathOrgId) {
    return isViewerRole(await getOrgRole(userId, pathOrgId));
  }
  const resolved = await resolveSessionOrg(
    request,
    userId,
    activeOrganizationId
  );
  // An org that does not resolve is the route's 404 to give.
  if ("error" in resolved) {
    if (!activeOrganizationId) {
      return false;
    }
  } else if (isViewerRole(resolved.role)) {
    return true;
  } else if (
    !activeOrganizationId ||
    resolved.organizationId === activeOrganizationId
  ) {
    return false;
  }
  // Routes that act on the session's org ignore the header, so a header
  // naming another org cannot lift the active org's check.
  return isViewerRole(await getOrgRole(userId, activeOrganizationId));
}

/**
 * True when the session caller is a viewer in the organization this request
 * acts on: an /api/organizations/<id>/ path segment, else the org
 * resolveSessionOrg picks (X-Organization-Id, then the active org, then the
 * first membership), the same resolver the routes use. When the header names
 * an org other than the active one, a viewer in either is refused.
 */
export async function isViewerForRequest(
  request: Request,
  userId: string,
  activeOrganizationId: string | null | undefined
): Promise<boolean> {
  const pathOrgId = orgIdFromPath(new URL(request.url).pathname);
  const header = request.headers.get(ORG_HEADER)?.trim() ?? "";
  const key = [
    userId,
    pathOrgId ?? "",
    header,
    activeOrganizationId ?? "",
  ].join("|");
  const cached = cacheGet(key);
  if (cached !== undefined) {
    return cached;
  }
  const isViewer = await resolveIsViewer(
    request,
    userId,
    pathOrgId,
    activeOrganizationId ?? null
  );
  cacheSet(key, isViewer);
  return isViewer;
}
