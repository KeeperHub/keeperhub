import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db/errors";
import { member, organization } from "@/lib/db/schema";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import {
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import { SettingsError } from "./settings";

type Authenticated = Exclude<DualAuthContext, { error: string }> & {
  userId: string;
};

export type OrgAccess = {
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

/** The caller's role in a live (not deactivated) org, or null. */
async function activeOrgRole(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
        isNull(organization.deactivatedAt)
      )
    )
    .limit(1);
  return row?.role ?? null;
}

/** 404 for orgs outside FAILURE_ALERTS_ROLLOUT, so every alert route stays hidden. */
function rolloutNotFound(organizationId: string): NextResponse | null {
  return isFailureAlertsEnabledForOrg(organizationId)
    ? null
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** Owners/admins manage, members read; API keys and OAuth tokens stay bound to their own org. */
export async function orgAccess(
  auth: Authenticated,
  organizationId: string
): Promise<OrgAccess | NextResponse> {
  if (auth.authMethod !== "session" && auth.organizationId !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const role = await activeOrgRole(auth.userId, organizationId);
  if (!role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const hidden = rolloutNotFound(organizationId);
  if (hidden) {
    return hidden;
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

/** The request's JSON object, or a 400 for anything else (null, an array, bad JSON). */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Send the settings as a JSON object." },
      { status: 400 }
    );
  }
  return body as Record<string, unknown>;
}
