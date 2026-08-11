import { NextResponse } from "next/server";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { organizationHasWallet } from "@/lib/web3/wallet-helpers";

/**
 * GET /api/scan/wallet-check
 *
 * Returns { hasWallet: boolean } for the authenticated user's organisation.
 * Used by the suggestion preview drawer to gate write-type suggestion flows
 * behind Turnkey wallet provision (FUNNEL-05).
 *
 * The organizationId is ALWAYS sourced from the server auth context
 * (getDualAuthContext) and NEVER from any request parameter. This prevents
 * cross-org wallet state probing (T-54-31).
 *
 * All v1.13 suggestions are read-only; this endpoint is forward-compat only
 * and is exercised via SYNTHETIC_WRITE_DESCRIPTOR in tests.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authContext = await getDualAuthContext(request);

  if ("error" in authContext) {
    return NextResponse.json(
      { error: authContext.error },
      { status: authContext.status }
    );
  }

  const { organizationId } = authContext;
  if (!organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 }
    );
  }

  const hasWallet = await organizationHasWallet(organizationId);
  return NextResponse.json({ hasWallet });
}
