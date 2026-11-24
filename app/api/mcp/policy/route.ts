import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  connectionsAboveCeiling,
  getOrgMaxScope,
  isSupportedScope,
  setOrgMaxScope,
} from "@/lib/mcp/connections";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveCaller } from "../connections/_lib/guard";

/**
 * PUT /api/mcp/policy
 *
 * The most any MCP agent in this organization may do.
 *
 * This writes one value: the organization's own ceiling. It does not touch a
 * person's limit or a session's granted scope. Those record decisions somebody
 * made, and rewriting them to match a ceiling would destroy what was chosen and
 * leave nothing to return to if the ceiling were raised again. The ceiling binds
 * anyway, because every call is judged against the lowest of the three, so
 * lowering it takes hold at once without editing anything else.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }
  if (!caller.isAdmin) {
    return NextResponse.json(
      { error: "Only organization admins and owners can set this" },
      { status: 403 }
    );
  }

  // A credential cannot raise the ceiling that binds it. This is the limit on
  // what an agent may do, so an agent holding an admin token could otherwise
  // widen its own reach back up to whatever it was minted with, and a challenge
  // would not help because there is nobody to ask. Policy writes are session
  // only for the same reason; so is this.
  if (caller.authMethod !== "session") {
    return NextResponse.json(
      {
        error:
          "The agent ceiling can only be changed from a signed-in session, not with an API key or token",
        code: "session_required",
      },
      { status: 403 }
    );
  }

  try {
    const body = (await request.json()) as { maxScope?: unknown };
    const next =
      body.maxScope === null || body.maxScope === undefined
        ? null
        : body.maxScope;
    if (next !== null && !isSupportedScope(next)) {
      return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
    }

    const before = await getOrgMaxScope(caller.organizationId);
    // Counted for the confirmation only. These are the agents the new ceiling
    // will hold down, not rows about to be rewritten.
    const affected = next
      ? (await connectionsAboveCeiling(caller.organizationId, next)).length
      : 0;

    await setOrgMaxScope(caller.organizationId, next);

    await recordAuditEvent({
      action: "mcp_policy.updated",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      after: { maxScope: next },
      before: { maxScope: before },
      metadata: { ...buildAuditMetadata(request), affectedSessions: affected },
      resourceId: caller.organizationId,
      resourceType: "mcp_policy",
    });

    return NextResponse.json({ affected, maxScope: next, success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpPolicy] Failed to set the agent ceiling",
      error,
      { endpoint: "/api/mcp/policy", operation: "put" }
    );
    return NextResponse.json(
      { error: "Could not save the policy" },
      { status: 500 }
    );
  }
}
