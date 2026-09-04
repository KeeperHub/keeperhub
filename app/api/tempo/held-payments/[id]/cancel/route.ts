/**
 * POST /api/tempo/held-payments/[id]/cancel -- cancel a pending held payment so
 * it is never broadcast. Guarded on `pending`, so a payment already claimed for
 * broadcast cannot be canceled out from under the sender. No step-up MFA: cancel
 * prevents a send rather than moving funds.
 */
import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { resolveCreatorContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import {
  buildActor,
  buildAuditMetadata,
  recordAuditEvent,
} from "@/lib/security/audit-log";
import { getOrgRole } from "@/lib/security/org-role";
import {
  cancelHeldPayment,
  getHeldPaymentForOrg,
} from "@/lib/tempo/held-payments";

export const dynamic = "force-dynamic";

const ENDPOINT = "/api/tempo/held-payments/[id]/cancel";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  { params }: RouteParams
): Promise<Response> {
  const { id } = await params;

  const resolved = await resolveCreatorContext(request);
  if ("error" in resolved) {
    return NextResponse.json(
      { error: resolved.error },
      { status: resolved.status }
    );
  }
  const scopeError = requireScope(resolved.scope, SCOPE_MCP_WRITE, {
    credentialType: resolved.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }
  const role = await getOrgRole(resolved.userId, resolved.organizationId);
  if (role !== "owner") {
    return NextResponse.json(
      { error: "Only organization owners can cancel held payments." },
      { status: 403 }
    );
  }

  try {
    const canceled = await cancelHeldPayment(id, resolved.organizationId);
    if (!canceled) {
      const existing = await getHeldPaymentForOrg(id, resolved.organizationId);
      if (!existing) {
        return NextResponse.json(
          { error: "Held payment not found." },
          {
            status: 404,
          }
        );
      }
      return NextResponse.json(
        {
          error: `Held payment is not pending (status: ${existing.status}); it cannot be canceled.`,
          code: "not-pending",
        },
        { status: 409 }
      );
    }
    await recordAuditEvent({
      actor: buildActor({
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        authMethod: resolved.authMethod,
        apiKeyId: resolved.apiKeyId,
      }),
      action: "tempo_held_payment.canceled",
      resourceType: "tempo_held_payment",
      resourceId: id,
      metadata: buildAuditMetadata(request),
    });
    return NextResponse.json({ ok: true, status: "canceled" });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Tempo Held] Cancel failed",
      error,
      {
        endpoint: ENDPOINT,
        operation: "cancel",
      }
    );
    return NextResponse.json(
      { error: "Failed to cancel held payment" },
      { status: 500 }
    );
  }
}
