import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { toChecksumAddress } from "@/lib/address-utils";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { authorizeAction } from "@/lib/middleware/authorize-action";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { exportKeyVerifySchema } from "@/lib/schemas/wallet";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { exportTurnkeyPrivateKey } from "@/lib/turnkey/turnkey-client";
import { validateBody } from "@/lib/validate-request";
import { checkVerifyRateLimit } from "../_lib/rate-limit";

/**
 * POST /api/user/wallet/export-key/verify
 *
 * Exports a Turnkey wallet's private key in plaintext. Authorization
 * stack (every check must pass):
 *
 *   1. authorizeAction — owner role floor, MFA enrolled, session step-up
 *                        cleared, and action step-up challenge (TOTP + email
 *                        for email/OAuth users; wallet signature for wallet
 *                        accounts).
 *   2. Wallet-creator check — wallet.userId === session.user.id. The TOTP
 *                              secret belongs to the user, but the wallet
 *                              might have been created by a different owner
 *                              of the same org.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const activeOrgId = getActiveOrgId(session);
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const rateLimit = checkVerifyRateLimit(session.user.id);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: "Too many verification attempts. Please wait before retrying.",
          retryAfter: rateLimit.retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfter) },
        }
      );
    }

    const bodyValidation = await validateBody(request, exportKeyVerifySchema);
    if (!bodyValidation.success) {
      return bodyValidation.response;
    }
    const body = bodyValidation.data;

    const authorized = await authorizeAction({
      session,
      action: STEP_UP_ACTIONS.walletExportKey,
      roleFloor: "owner",
      organizationId: activeOrgId,
      body,
      headers: request.headers,
    });
    if (!authorized.ok) {
      return authorized.response;
    }

    const wallets = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, activeOrgId))
      .limit(1);

    if (wallets.length === 0) {
      return NextResponse.json(
        { error: "No Turnkey wallet found" },
        { status: 404 }
      );
    }

    const wallet = wallets[0];

    if (wallet.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Only the wallet creator can export its private key" },
        { status: 403 }
      );
    }

    if (!wallet.turnkeySubOrgId) {
      return NextResponse.json(
        { error: "Turnkey wallet configuration is incomplete" },
        { status: 500 }
      );
    }

    const keyType = body.keyType ?? "evm";

    if (keyType === "solana" && !wallet.solanaAddress) {
      return NextResponse.json(
        { error: "No Solana account is configured for this wallet" },
        { status: 400 }
      );
    }

    const exportAddress =
      keyType === "solana"
        ? wallet.solanaAddress
        : toChecksumAddress(wallet.walletAddress);

    if (!exportAddress) {
      return NextResponse.json(
        { error: "Wallet address is not configured" },
        { status: 500 }
      );
    }

    const privateKey = await exportTurnkeyPrivateKey(
      wallet.turnkeySubOrgId,
      exportAddress,
      keyType
    );

    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: activeOrgId,
        authMethod: "session",
      },
      action: "wallet.private_key_exported",
      resourceType: "wallet",
      resourceId:
        keyType === "solana" ? wallet.solanaAddress : wallet.walletAddress,
      after: {
        keyType,
        walletAddress:
          keyType === "solana"
            ? wallet.solanaAddress
            : toChecksumAddress(wallet.walletAddress),
      },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      privateKey,
      keyType,
      format: "hex",
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Wallet] Failed to verify and export private key",
      error,
      { endpoint: "/api/user/wallet/export-key/verify", operation: "post" }
    );
    return apiError(error, "Failed to export private key");
  }
}
