/**
 * GET /api/agentic-wallet/approval-request/:id
 *
 * HMAC-authenticated poll of an approval request's current state. The agent
 * client signs an EMPTY body (GET has no body), so the HMAC signing string
 * uses sha256("") as the body digest. `verifyHmacRequest(request, "")` matches
 * that contract.
 *
 * Cross-sub-org reads return 404 (not 403) to avoid leaking existence of
 * records owned by a different sub-org (T-33-06b).
 *
 * Response: 200 { id, status, riskLevel, operationPayload, createdAt, resolvedAt }
 */
import { getApprovalRequest } from "@/lib/agentic-wallet/approval";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  // GET carries no body; the client must sign sha256("") for the body digest
  // slot in the HMAC signing string. This mirrors how curl/fetch send GET.
  const auth = await verifyHmacRequest(request, "");
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const { id } = await context.params;
  const row = await getApprovalRequest(id);
  if (!row) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // T-33-06b: cross-sub-org probe returns 404, not 403, so callers cannot use
  // a known id to test whether a row exists under another sub-org.
  if (row.subOrgId !== auth.subOrgId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({
    id: row.id,
    status: row.status,
    riskLevel: row.riskLevel,
    operationPayload: row.operationPayload,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
  });
}
