/**
 * POST /api/agentic-wallet/approval-request
 *
 * HMAC-authenticated creation of a pending wallet approval request. The agent
 * client signs the raw body with its per-sub-org HMAC secret; the server maps
 * the signature back to the sub-org and inserts a pending row so the user can
 * approve or reject via the session-authenticated /:id/approve route.
 *
 * Request body: { riskLevel: "ask" | "block", operationPayload: object }
 * Response: 201 { id: string }
 *
 * T-33-02 (Information Disclosure): logSystemError metadata carries only
 * endpoint + subOrgId -- never the raw body or the HMAC secret.
 */
import { and, count, eq, gt } from "drizzle-orm";
import {
  createApprovalRequest,
  deriveApprovalBinding,
} from "@/lib/agentic-wallet/approval";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import { db } from "@/lib/db";
import { walletApprovalRequests } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

// Phase 37 fix B3: upper bound on simultaneous pending approval requests per
// sub-org. Caps DoS/noise vectors where an attacker (or a bug) floods the
// table with never-resolved rows. Pending-only -- approved/rejected/expired
// rows do not count against the quota.
const PENDING_QUOTA_PER_SUB_ORG = 10;

type CreateRequestBody = {
  riskLevel?: unknown;
  operationPayload?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const auth = await verifyHmacRequest(request, rawBody);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: CreateRequestBody;
  try {
    body = JSON.parse(rawBody) as CreateRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.riskLevel !== "ask" && body.riskLevel !== "block") {
    return Response.json(
      { error: "riskLevel must be 'ask' or 'block'" },
      { status: 400 }
    );
  }
  if (
    !body.operationPayload ||
    typeof body.operationPayload !== "object" ||
    Array.isArray(body.operationPayload)
  ) {
    return Response.json(
      { error: "operationPayload must be an object" },
      { status: 400 }
    );
  }

  // Phase 37 fix B1: extract + validate the binding fields from
  // operationPayload via the shared deriveApprovalBinding helper. The server
  // writes these to dedicated bound_* columns so /approve can refuse to
  // resolve a row whose payload was mutated after create. The same helper is
  // reused by /sign (ask-tier) and by Task 13's checkApprovalForResolve to
  // guarantee create-time and resolve-time derivation cannot drift.
  const op = body.operationPayload as Record<string, unknown>;
  const binding = deriveApprovalBinding(op.chain, op.paymentChallenge);
  if (!binding) {
    return Response.json(
      {
        error:
          "operationPayload must include chain + paymentChallenge with a valid recipient and positive integer amount",
        code: "BINDING_REQUIRED",
      },
      { status: 422 }
    );
  }

  // Phase 37 fix B3: payload size cap.
  if (JSON.stringify(body.operationPayload).length > 8 * 1024) {
    return Response.json(
      {
        error: "operationPayload too large (>8 KiB)",
        code: "PAYLOAD_TOO_LARGE",
      },
      { status: 413 }
    );
  }

  // Phase 37 fix B3: per-sub-org pending-row count cap. Blocks flooding the
  // approval table with unresolved rows before we even attempt the insert.
  // Only status='pending' AND not-yet-expired counts toward the quota --
  // terminal rows (approved/rejected/expired) are ignored, and stale-expired
  // pending rows (those that timed out before anyone called /approve, which
  // would otherwise flip them via the lazy path) are also excluded. This
  // makes the quota self-cleaning without relying on the sweeper cron: a row
  // whose expires_at has passed no longer counts, even if status has not yet
  // flipped to 'expired'. The cron sweeper is still useful for disk hygiene
  // but the quota stays functional if the scheduler is ever paused.
  const pendingCountRows = await db
    .select({ n: count() })
    .from(walletApprovalRequests)
    .where(
      and(
        eq(walletApprovalRequests.subOrgId, auth.subOrgId),
        eq(walletApprovalRequests.status, "pending"),
        gt(walletApprovalRequests.expiresAt, new Date())
      )
    );
  if ((pendingCountRows[0]?.n ?? 0) >= PENDING_QUOTA_PER_SUB_ORG) {
    return Response.json(
      {
        error: "Pending approval quota exceeded",
        code: "PENDING_QUOTA_EXCEEDED",
      },
      { status: 429 }
    );
  }

  try {
    const { id } = await createApprovalRequest({
      subOrgId: auth.subOrgId,
      riskLevel: body.riskLevel,
      operationPayload: body.operationPayload as Record<string, unknown>,
      binding,
    });
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Agentic] /approval-request create failed",
      error,
      {
        endpoint: "/api/agentic-wallet/approval-request",
        subOrgId: auth.subOrgId,
      }
    );
    return Response.json(
      { error: "Failed to create approval request" },
      { status: 500 }
    );
  }
}
