import "server-only";

import { NextResponse } from "next/server";
import { isUniqueViolation } from "@/lib/db/errors";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { getOrgRole } from "@/lib/security/org-role";
import { SettingsError } from "./settings";

type Authenticated = Exclude<DualAuthContext, { error: string }> & {
  userId: string;
};

type OrgAccess = {
  userId: string;
  role: string;
  canManage: boolean;
  authMethod: Authenticated["authMethod"];
  apiKeyId: string | null;
  scope?: string;
};

/** Who is asking, before anything about the resource is looked up. */
export async function authenticate(
  request: Request
): Promise<Authenticated | NextResponse> {
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
  return { ...auth, userId: auth.userId };
}

/**
 * Whether they may read or change this org's failure notifications. Owners
 * and admins manage them (the same people who manage members); any member may
 * read them. An API key or OAuth token is held to the organization it was
 * issued for, even when its user also belongs to others.
 */
export async function orgAccess(
  auth: Authenticated,
  organizationId: string
): Promise<OrgAccess | NextResponse> {
  if (auth.authMethod !== "session" && auth.organizationId !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const role = await getOrgRole(auth.userId, organizationId);
  if (!role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return {
    userId: auth.userId,
    role,
    canManage: role === "owner" || role === "admin",
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId,
    scope: auth.scope,
  };
}

export async function resolveOrgAccess(
  request: Request,
  organizationId: string
): Promise<OrgAccess | NextResponse> {
  const auth = await authenticate(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  return await orgAccess(auth, organizationId);
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
  if (isUniqueViolation(error)) {
    // The same connection and destination twice in one list.
    return NextResponse.json(
      { error: "That channel is already in the list." },
      { status: 409 }
    );
  }
  return null;
}
