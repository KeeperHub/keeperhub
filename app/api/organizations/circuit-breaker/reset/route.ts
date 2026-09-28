import { type NextRequest, NextResponse } from "next/server";
import { resetOrgCircuitBreaker } from "@/lib/execute/org-circuit-breaker";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requirePermission } from "@/lib/middleware/require-org";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

/**
 * Clear the caller's organization circuit breaker so runs resume.
 *
 * This is the guaranteed recovery path. A halted org dispatches no workflows, so
 * the in-workflow Reset action can never run while halted; an operator must be
 * able to reach a plain HTTP endpoint that does not go through workflow
 * dispatch. Gated by `organization:update` (admin/owner) over the session - the
 * same gate the spend-cap setter uses. A kh_ API key or MCP OAuth token
 * authenticates a different layer and never carries an org session, so it cannot
 * reset the breaker.
 */
export const POST = requirePermission(
  "organization",
  ["update"],
  async (req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    const userId = context.user?.id;
    if (!(organizationId && userId)) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    try {
      const result = await resetOrgCircuitBreaker({
        organizationId,
        requestedByUserId: userId,
      });

      if (!result.reset) {
        return NextResponse.json(
          {
            error:
              "Only organization admins and owners can reset the circuit breaker",
          },
          { status: 403 }
        );
      }

      await recordAuditEvent({
        actor: {
          userId,
          organizationId,
          authMethod: "session",
          actorLabel: userId,
        },
        action: "org.circuit_breaker.reset",
        resourceType: "organization",
        resourceId: organizationId,
        after: { wasHalted: result.wasHalted },
        metadata: buildAuditMetadata(req),
      });

      return NextResponse.json({ reset: true, wasHalted: result.wasHalted });
    } catch (error) {
      logSystemError(
        ErrorCategory.INFRASTRUCTURE,
        "[CircuitBreaker] Failed to reset circuit breaker",
        error,
        { organizationId }
      );
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  }
);
