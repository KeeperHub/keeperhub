import { ErrorCategory, logSystemError } from "@/lib/logging";
import { revokeRefreshTokensForUserOrg } from "@/lib/mcp/oauth-store";
import { isViewerRole } from "@/lib/organization/role-label";

/**
 * Viewers have UI-only access, so a downgrade to viewer clears the member's
 * renewable MCP OAuth refresh tokens for the org, as a removal does. Use is
 * already refused per request; this stops the grant from renewing. Best-effort:
 * a failure is logged and never fails the role change.
 */
export async function revokeMcpGrantsOnViewerDowngrade(params: {
  userId: string;
  organizationId: string;
  previousRole: string | null | undefined;
  role: string | null | undefined;
}): Promise<void> {
  if (!isViewerRole(params.role) || isViewerRole(params.previousRole)) {
    return;
  }
  try {
    await revokeRefreshTokensForUserOrg(params.userId, params.organizationId);
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[Org] Failed to revoke MCP OAuth refresh tokens after viewer downgrade",
      err,
      { userId: params.userId, organizationId: params.organizationId }
    );
  }
}
