/**
 * POST /api/agentic-wallet/link
 *
 * Late-bound wallet linking. Associates an anonymous Turnkey sub-org with a
 * KeeperHub user account. Per CONTEXT Resolution #4, requires BOTH:
 *
 *   1. A valid HMAC request signature (proves the caller owns the sub-org via
 *      the HMAC secret issued at provision time).
 *   2. A valid Better Auth session (identifies the target KeeperHub user).
 *
 * Either factor alone is insufficient:
 *   - HMAC alone: no user to link to.
 *   - Session alone: attacker with a stolen cookie could link any sub-org,
 *     including one discovered by guessing subOrgId strings.
 *
 * Additional defence: body.subOrgId must equal hmacResult.subOrgId. This
 * prevents a crafted body from trying to link sub-org B while signing with
 * sub-org A's HMAC secret (T-33-05b, STRIDE Tampering).
 *
 * Lifecycle:
 *   - 401 MISSING_SESSION  -> no Better Auth session on the request
 *   - 401 HMAC_INVALID     -> HMAC headers missing or signature bad
 *   - 400 INVALID_JSON     -> body not JSON
 *   - 400 MISSING_SUB_ORG  -> body.subOrgId absent/empty
 *   - 403 SUB_ORG_MISMATCH -> body.subOrgId != hmacResult.subOrgId
 *   - 404 WALLET_NOT_FOUND -> sub-org not in agentic_wallets at all
 *   - 409 ALREADY_LINKED   -> wallet is linked to a different user
 *   - 200 { ok: true }             -> newly linked
 *   - 200 { ok: true, already: true } -> idempotent re-link by same user
 *
 * The update predicate (`WHERE sub_org_id = ? AND linked_user_id IS NULL`) is
 * race-safe: only the first of two concurrent link attempts for the same wallet
 * succeeds; the second sees zero rows updated and resolves via the re-read
 * branch to either 200 {already:true} (same user) or 409 (different user).
 */
import { and, eq, isNull } from "drizzle-orm";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { agenticWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getOrgContext } from "@/lib/middleware/org-context";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

type LinkRequestBody = {
  subOrgId?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // 1. HMAC first: proof-of-possession of the sub-org's secret. Runs before
  // the session read so a caller without HMAC headers cannot probe session
  // state (T-33-05 mitigation).
  const hmacResult = await verifyHmacRequest(request, rawBody);
  if (!hmacResult.ok) {
    return Response.json(
      { error: hmacResult.error, code: "HMAC_INVALID" },
      { status: hmacResult.status }
    );
  }

  // 2. Session: target user for the link.
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return Response.json(
      { error: "Unauthorized", code: "MISSING_SESSION" },
      { status: 401 }
    );
  }

  // 3. Body sanity.
  let body: LinkRequestBody;
  try {
    body = JSON.parse(rawBody) as LinkRequestBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON", code: "INVALID_JSON" },
      { status: 400 }
    );
  }
  if (typeof body.subOrgId !== "string" || body.subOrgId.length === 0) {
    return Response.json(
      { error: "subOrgId required", code: "MISSING_SUB_ORG" },
      { status: 400 }
    );
  }

  // 4. Tamper guard: body sub-org must match HMAC-verified sub-org.
  if (body.subOrgId !== hmacResult.subOrgId) {
    return Response.json(
      { error: "sub-org mismatch", code: "SUB_ORG_MISMATCH" },
      { status: 403 }
    );
  }

  const userId = session.user.id;
  const subOrgId = body.subOrgId;

  // Linking is the first moment anybody knows who this wallet belongs to, so it
  // is where the organization answerable for its signing is recorded. Without
  // it the wallet signs outside every rule its owner has written, because
  // policy is org-scoped and there would be no organization to look up.
  const orgContext = await getOrgContext();
  const organizationId = orgContext.organization?.id ?? null;

  try {
    const updated = await db
      .update(agenticWallets)
      .set({ linkedUserId: userId, linkedAt: new Date(), organizationId })
      .where(
        and(
          eq(agenticWallets.subOrgId, subOrgId),
          isNull(agenticWallets.linkedUserId)
        )
      )
      .returning({ id: agenticWallets.id });

    if (updated.length === 0) {
      // Zero rows: either wallet is already linked, or wallet does not exist.
      // Re-read to distinguish the three cases.
      const existing = await db
        .select({ linkedUserId: agenticWallets.linkedUserId })
        .from(agenticWallets)
        .where(eq(agenticWallets.subOrgId, subOrgId))
        .limit(1);

      if (existing.length === 0) {
        return Response.json(
          { error: "Wallet not found", code: "WALLET_NOT_FOUND" },
          { status: 404 }
        );
      }
      if (existing[0]?.linkedUserId === userId) {
        // Idempotent: same user re-linking is a no-op success.
        return Response.json({ ok: true, already: true }, { status: 200 });
      }
      return Response.json(
        {
          error: "Wallet already linked to another user",
          code: "ALREADY_LINKED",
        },
        { status: 409 }
      );
    }

    await recordAuditEvent({
      actor: { userId, organizationId, authMethod: "session" },
      action: "agentic_wallet.linked",
      resourceType: "agentic_wallet",
      resourceId: subOrgId,
      after: { linkedUserId: userId, organizationId },
      metadata: buildAuditMetadata(request),
    });

    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Agentic] /link failed", error, {
      endpoint: "/api/agentic-wallet/link",
      subOrgId,
      userId,
    });
    return Response.json(
      { error: "Link failed", code: "LINK_FAILED" },
      { status: 500 }
    );
  }
}
