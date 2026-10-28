import "server-only";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import type { AuthMethod } from "@/lib/middleware/auth-helpers";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { SettingsError } from "./settings";

export type OrgAccess = {
  userId: string;
  role: string;
  canManage: boolean;
  authMethod: AuthMethod;
  apiKeyId: string | null;
  scope?: string;
};

/**
 * Who is asking, and whether they may change failure notifications. Owners
 * and admins manage them (the same people who manage members); any member
 * may read them. API-key callers are held to their own organization.
 */
export async function resolveOrgAccess(
  request: Request,
  organizationId: string
): Promise<OrgAccess | NextResponse> {
  const auth = await getDualAuthContext(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.userId) {
    return NextResponse.json(
      { error: "Auth context missing user" },
      { status: 400 }
    );
  }
  if (auth.authMethod === "api-key" && auth.organizationId !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, auth.userId)
      )
    )
    .limit(1);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return {
    userId: auth.userId,
    role: membership.role,
    canManage: membership.role === "owner" || membership.role === "admin",
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId,
    scope: auth.scope,
  };
}

/** For writes: owners and admins only, and a write scope for OAuth callers. */
export function requireManager(access: OrgAccess): NextResponse | null {
  if (!access.canManage) {
    return NextResponse.json(
      { error: "Only owners and admins can change failure notifications." },
      { status: 403 }
    );
  }
  return requireScope(access.scope, SCOPE_MCP_WRITE, {
    credentialType: access.authMethod,
  });
}

export function settingsErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof SettingsError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  return null;
}
