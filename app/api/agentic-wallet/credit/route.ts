/**
 * GET /api/agentic-wallet/credit
 *
 * HMAC-authenticated off-chain KeeperHub credit balance read.
 *
 * Authenticates the caller via the Phase 33 HMAC primitive
 * (X-KH-Sub-Org + X-KH-Timestamp + X-KH-Signature). The signing string matches
 * the format enforced by verifyHmacRequest (HI-05):
 *
 *   `${method}\n${pathname}\n${subOrgId}\n${sha256_hex(body)}\n${timestamp}`
 *
 * For GET the client signs an empty body string; sha256_hex("") is the
 * canonical digest. Aggregates the sub-org's signed credit ledger
 * (positive = grant, negative = spend) and returns the total as a USD
 * decimal string.
 *
 * Phase 34 Plan 04 (checkBalance) consumes this endpoint as the third leg
 * of the unified balance view alongside on-chain Base + Tempo balances
 * (PAY-05).
 *
 * Response shapes:
 *   200 { amount: "0.50", currency: "USD", subOrgId: string }
 *   401 { error, code: "HMAC_MISSING" | "HMAC_INVALID" | "HMAC_STALE" }
 *   404 { error: "Unknown sub-org", code: "WALLET_NOT_FOUND" }
 *   500 { error: "Internal error", code: "INTERNAL" }
 *
 * T-34-cr-01 / T-34-cr-02 mitigation: the SUM query is keyed on
 * auth.subOrgId (the HMAC-verified sub-org) rather than any caller-supplied
 * body or query field. HI-05 binds subOrgId into the signed bytes so a
 * tampered X-KH-Sub-Org header cannot pass verifyHmacRequest.
 *
 * T-34-cr-04 mitigation: logSystemError metadata carries only endpoint +
 * subOrgId; we never log the raw body, signature, or HMAC secret.
 */
import { eq, sql } from "drizzle-orm";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import { db } from "@/lib/db";
import { agenticWalletCredits } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export const dynamic = "force-dynamic";

function mapAuthFailureToCode(
  status: number,
  errorMessage: string
): "HMAC_MISSING" | "HMAC_INVALID" | "HMAC_STALE" | "WALLET_NOT_FOUND" {
  if (status === 404) {
    return "WALLET_NOT_FOUND";
  }
  if (errorMessage.includes("Missing")) {
    return "HMAC_MISSING";
  }
  if (errorMessage.includes("Timestamp")) {
    return "HMAC_STALE";
  }
  return "HMAC_INVALID";
}

export async function GET(request: Request): Promise<Response> {
  // HMAC over an empty body for GET — client hmac.ts passes body === "" on
  // GET requests, so sha256_hex("") is the canonical digest here.
  const auth = await verifyHmacRequest(request, "");
  if (!auth.ok) {
    const code = mapAuthFailureToCode(auth.status, auth.error);
    return Response.json({ error: auth.error, code }, { status: auth.status });
  }

  try {
    // COALESCE(SUM(amount_usdc_cents), 0) guarantees a numeric result when
    // the sub-org exists in agentic_wallets (HMAC-secret lookup succeeded)
    // but has no credit ledger rows. The result arrives as a string from
    // Postgres numeric-to-text casting; parseInt normalises it.
    const result = await db
      .select({
        totalCents: sql<string>`COALESCE(SUM(${agenticWalletCredits.amountUsdcCents}), 0)::text`,
      })
      .from(agenticWalletCredits)
      .where(eq(agenticWalletCredits.subOrgId, auth.subOrgId));

    const rawCents = result[0]?.totalCents ?? "0";
    const totalCents = Number.parseInt(rawCents, 10);
    // WR-02: a SUM over numeric-to-text that exceeds 2^53 - 1 collapses to
    // NaN after parseInt; refuse to emit a misleading "NaN" amount to the
    // caller. The error envelope is opaque (INTERNAL) per the existing
    // /credit failure shape.
    if (!Number.isFinite(totalCents)) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[Agentic] /credit sum not finite",
        null,
        {
          endpoint: "/api/agentic-wallet/credit",
          operation: "read",
          subOrgId: auth.subOrgId,
        }
      );
      return Response.json(
        { error: "Internal error", code: "INTERNAL" },
        { status: 500 }
      );
    }
    const amountUsd = (totalCents / 100).toFixed(2);

    return Response.json({
      amount: amountUsd,
      currency: "USD",
      subOrgId: auth.subOrgId,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Agentic] /credit read failed",
      error,
      {
        endpoint: "/api/agentic-wallet/credit",
        operation: "read",
        subOrgId: auth.subOrgId,
      }
    );
    return Response.json(
      { error: "Internal error", code: "INTERNAL" },
      { status: 500 }
    );
  }
}
