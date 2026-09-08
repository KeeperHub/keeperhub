import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getConnection, revokeConnection } from "@/lib/mcp/connections";
import { bumpScopeEpoch } from "@/lib/mcp/scope-policy";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveCaller } from "../_lib/guard";

type Params = { params: Promise<{ connectionId: string }> };

/**
 * DELETE /api/mcp/connections/{id}
 *
 * Cuts a connection off. A member may do this to their own; admins and owners
 * to any in the organization.
 */
export async function DELETE(
  request: Request,
  context: Params
): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }

  try {
    const { connectionId } = await context.params;
    const connection = await getConnection(connectionId, caller.organizationId);
    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }
    // A member owns only their own connections. Checked against the row rather
    // than anything the caller supplied.
    if (!(caller.isAdmin || connection.userId === caller.userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await revokeConnection(connectionId, caller.organizationId);
    await bumpScopeEpoch(connection.userId, caller.organizationId);

    await recordAuditEvent({
      action: "mcp_connection.revoked",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      before: { clientName: connection.clientName, scope: connection.scope },
      metadata: {
        ...buildAuditMetadata(request),
        clientName: connection.clientName,
        subjectUserId: connection.userId,
      },
      resourceId: connectionId,
      resourceType: "mcp_connection",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpConnections] Failed to revoke a connection",
      error,
      { endpoint: "/api/mcp/connections/[id]", operation: "delete" }
    );
    return NextResponse.json(
      { error: "Could not revoke the connection" },
      { status: 500 }
    );
  }
}
