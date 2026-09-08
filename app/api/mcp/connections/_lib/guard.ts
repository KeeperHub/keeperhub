import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";

export type ConnectionsCaller = {
  ok: true;
  userId: string;
  organizationId: string;
  role: string;
  isAdmin: boolean;
  authMethod: string;
  apiKeyId?: string | null;
  scope?: string;
};

export type CallerError = { ok: false; status: number; error: string };

/**
 * Who is asking, and whether they administer this organization.
 *
 * Membership is read from the database rather than taken from the request, so
 * a caller cannot claim a role. Admins and owners manage every connection in
 * the organization; a member is confined to their own, which the callers
 * enforce by passing their own userId as the filter.
 */
/** The role someone holds in an organization, or null if not a member. */
export async function roleOf(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);
  return row?.role ?? null;
}

export async function resolveCaller(
  request: Request
): Promise<ConnectionsCaller | CallerError> {
  const authContext = await getDualAuthContext(request);
  if ("error" in authContext) {
    return { error: authContext.error, ok: false, status: authContext.status };
  }
  const { userId, organizationId, authMethod } = authContext;
  if (!(userId && organizationId)) {
    return { error: "Auth context missing user", ok: false, status: 400 };
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .limit(1);

  if (!membership) {
    return { error: "Forbidden", ok: false, status: 403 };
  }

  return {
    apiKeyId: authContext.apiKeyId,
    authMethod,
    isAdmin: membership.role === "owner" || membership.role === "admin",
    ok: true,
    organizationId,
    role: membership.role,
    scope: authContext.scope,
    userId,
  };
}
