import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import {
  AUTH_METHOD_API_KEY,
  type AuthMethod,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { type OrgRole, OrgRoles } from "@/lib/organization/role-label";

export type OrgRoleAccess = {
  ok: true;
  userId: string;
  role: OrgRole;
  authMethod: AuthMethod;
  apiKeyId: string | null;
  scope?: string;
};

export type OrgRoleDenied = { ok: false; status: number; error: string };

const FORBIDDEN = "Forbidden";

export const ORG_OWNER_ONLY: ReadonlySet<OrgRole> = new Set([OrgRoles.OWNER]);
export const ORG_MANAGERS: ReadonlySet<OrgRole> = new Set([
  OrgRoles.OWNER,
  OrgRoles.ADMIN,
]);
export const ORG_ANY_MEMBER: ReadonlySet<OrgRole> = new Set(
  Object.values(OrgRoles)
);

/**
 * Resolve the caller and require one of `allowedRoles` in the organization
 * named by the route. An API key only reaches the organization it belongs to.
 */
export async function requireOrgRole(
  request: Request,
  organizationId: string,
  allowedRoles: ReadonlySet<OrgRole>
): Promise<OrgRoleAccess | OrgRoleDenied> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { ok: false, status: authContext.status, error: authContext.error };
  }
  const { userId, organizationId: callerOrgId, authMethod } = authContext;
  if (!userId) {
    return { ok: false, status: 400, error: "Auth context missing user" };
  }
  if (authMethod === AUTH_METHOD_API_KEY && callerOrgId !== organizationId) {
    return { ok: false, status: 403, error: FORBIDDEN };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);

  const role = membership?.role as OrgRole | undefined;
  if (!(role && allowedRoles.has(role))) {
    return { ok: false, status: 403, error: FORBIDDEN };
  }
  return {
    ok: true,
    userId,
    role,
    authMethod,
    apiKeyId: authContext.apiKeyId,
    scope: authContext.scope,
  };
}
