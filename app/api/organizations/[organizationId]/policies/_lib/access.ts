import "server-only";

/**
 * The role gate for every policy route.
 *
 * Policy is the meta case: a guardrail whoever it constrains can edit is not a
 * guardrail. So reads are admin or owner, and writes are owner only. That is
 * deliberately stricter than the rest of the settings surface.
 *
 * Built on getDualAuthContext so an API key or OAuth token is handled the same
 * way a session is, and a key scoped to a different organization is refused
 * rather than silently reading across the boundary.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { PolicyRole } from "@/lib/policy";

export type PolicyAccess =
  | {
      ok: true;
      userId: string;
      role: PolicyRole;
      authMethod: "oauth" | "api-key" | "session";
      apiKeyId?: string;
      scope?: string;
    }
  | { ok: false; response: NextResponse };

function deny(status: number, code: string, error: string): PolicyAccess {
  return {
    ok: false,
    response: NextResponse.json({ error, code }, { status }),
  };
}

export async function requireOrgPolicyAccess(
  request: Request,
  organizationId: string,
  mode: "read" | "write"
): Promise<PolicyAccess> {
  const auth = await getDualAuthContext(request);
  if ("error" in auth) {
    return deny(auth.status, auth.code ?? "unauthorized", auth.error);
  }
  if (!auth.userId) {
    return deny(400, "no_user", "This action requires a signed-in user");
  }
  // A credential issued for another organization must never read or write here,
  // even when the caller names this organization in the path.
  if (auth.organizationId !== organizationId) {
    return deny(
      403,
      "wrong_organization",
      "This credential is not valid for this organization"
    );
  }

  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, auth.userId),
        eq(member.organizationId, organizationId)
      )
    )
    .limit(1);

  const role = row?.role as PolicyRole | undefined;
  if (!role) {
    return deny(
      403,
      "not_a_member",
      "You are not a member of this organization"
    );
  }

  if (mode === "write" && role !== PolicyRole.OWNER) {
    return deny(
      403,
      "not_owner",
      "Only the organization owner can change policy"
    );
  }
  if (
    mode === "read" &&
    role !== PolicyRole.OWNER &&
    role !== PolicyRole.ADMIN
  ) {
    return deny(
      403,
      "not_admin_or_owner",
      "Only organization admins and owners can view policy"
    );
  }

  return {
    ok: true,
    userId: auth.userId,
    role,
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId ?? undefined,
    scope: auth.scope ?? undefined,
  };
}
