import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { integrations, organizationWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { getActiveOrgId } from "@/lib/middleware/org-context";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { provisionOrganizationWallet } from "@/lib/turnkey/provision-org-wallet";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper: Validate user authentication, organization membership, and admin permissions
async function validateUserAndOrganization(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return { error: "Unauthorized", status: 401 };
  }

  const user = session.user;

  if (!user.email) {
    return { error: "Email required to create wallet", status: 400 };
  }

  // Check if user is anonymous
  if (
    user.email.includes("@http://") ||
    user.email.includes("@https://") ||
    user.email.startsWith("temp-")
  ) {
    return {
      error:
        "Anonymous users cannot create wallets. Please sign in with a real account.",
      status: 400,
    };
  }

  // Get active organization from session
  const activeOrgId = getActiveOrgId(session);

  if (!activeOrgId) {
    return {
      error: "No active organization. Please select or create an organization.",
      status: 400,
    };
  }

  // Get user's member record in the active organization
  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  if (!activeMember) {
    return {
      error: "You are not a member of the active organization",
      status: 403,
    };
  }

  // Check if user has admin or owner role
  const role = activeMember.role;
  if (role !== "admin" && role !== "owner") {
    return {
      error: "Only organization admins and owners can manage wallets",
      status: 403,
    };
  }

  return { user, organizationId: activeOrgId, member: activeMember };
}

// Helper: Check if a wallet already exists for this organization.
async function checkExistingWallet(
  organizationId: string
): Promise<{ error: string; status: number } | { valid: true }> {
  const existing = await db
    .select({ id: organizationWallets.id })
    .from(organizationWallets)
    .where(eq(organizationWallets.organizationId, organizationId))
    .limit(1);

  if (existing.length > 0) {
    return {
      error: "A wallet already exists for this organization",
      status: 400,
    };
  }

  return { valid: true };
}

// Helper: Get user-friendly error response for wallet creation failures
function getErrorResponse(error: unknown): NextResponse {
  // Catch DB unique constraint violation (race condition: wallet already exists)
  if (error instanceof Error) {
    const cause = error.cause;
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "23505"
    ) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Wallet] Race condition: external wallet created but DB insert hit unique constraint",
        error,
        { endpoint: "/api/user/wallet", operation: "post" }
      );
      return NextResponse.json(
        { error: "A wallet already exists for this organization" },
        { status: 409 }
      );
    }
  }

  logSystemError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Wallet] Creation failed",
    error,
    { endpoint: "/api/user/wallet", operation: "post" }
  );

  let errorMessage = "Failed to create wallet";
  let statusCode = 500;

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes("already exists")) {
      errorMessage = "A wallet already exists for this email address";
      statusCode = 409;
    } else if (message.includes("invalid email")) {
      errorMessage = "Invalid email format";
      statusCode = 400;
    } else if (message.includes("forbidden") || message.includes("403")) {
      errorMessage = "API key authentication failed. Please contact support.";
      statusCode = 403;
    } else {
      errorMessage = error.message;
    }
  }

  return NextResponse.json({ error: errorMessage }, { status: statusCode });
}

export async function GET(request: Request): Promise<NextResponse> {
  let authContext: DualAuthContext | null = null;
  try {
    authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const { userId, organizationId: activeOrgId } = authContext;
    if (!activeOrgId) {
      return NextResponse.json(
        { error: "No active organization" },
        { status: 400 }
      );
    }

    const active = await db
      .select()
      .from(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, activeOrgId),
          eq(organizationWallets.isActive, true)
        )
      )
      .limit(1);

    if (active.length === 0) {
      return NextResponse.json({
        hasWallet: false,
        message: "No wallet found for this organization",
      });
    }

    const wallet = active[0];

    return NextResponse.json({
      hasWallet: true,
      id: wallet.id,
      canExportKey: wallet.turnkeySubOrgId !== null,
      // Only the wallet creator may export its key, regardless of org role.
      // For API-key callers without a recorded creator (userId === null) this
      // resolves to false, which is correct: key export is session-only.
      isOwner: userId !== null && wallet.userId === userId,
      walletAddress: wallet.walletAddress,
      solanaAddress: wallet.solanaAddress ?? null,
      walletId: wallet.turnkeyWalletId,
      email: wallet.email,
      createdAt: wallet.createdAt,
      organizationId: wallet.organizationId,
      isActive: wallet.isActive,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get wallet", error, {
      endpoint: "/api/user/wallet",
      operation: "get",
      ...auditFromAuth(authContext),
    });
    return apiError(error, "Failed to get wallet");
  }
}

export async function POST(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { user, organizationId } = validation;

    const body: { email?: string } = await request.json();
    const walletEmail = body.email;

    if (!walletEmail || typeof walletEmail !== "string") {
      return NextResponse.json(
        { error: "Email is required to create a wallet" },
        { status: 400 }
      );
    }

    if (walletEmail.length > 254 || !EMAIL_REGEX.test(walletEmail)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    const existingCheck = await checkExistingWallet(organizationId);
    if ("error" in existingCheck) {
      return NextResponse.json(
        { error: existingCheck.error },
        { status: existingCheck.status }
      );
    }

    const result = await provisionOrganizationWallet({
      userId: user.id,
      organizationId,
      email: walletEmail,
    });

    // checkExistingWallet passed, so a non-created result means a concurrent
    // request created the wallet first.
    if (!result.created) {
      return NextResponse.json(
        { error: "A wallet already exists for this organization" },
        { status: 409 }
      );
    }

    await recordAuditEvent({
      actor: { userId: user.id, organizationId, authMethod: "session" },
      action: "org_wallet.created",
      resourceType: "org_wallet",
      resourceId: result.subOrgId ?? organizationId,
      after: { walletAddress: result.walletAddress },
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({
      success: true,
      wallet: {
        address: result.walletAddress,
        walletId: result.walletId,
        email: walletEmail,
        organizationId,
      },
    });
  } catch (error) {
    return getErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    // 1. Validate user, organization, and admin permissions
    const validation = await validateUserAndOrganization(request);
    if ("error" in validation) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { organizationId } = validation;

    const deletedWallet = await db
      .delete(organizationWallets)
      .where(
        and(
          eq(organizationWallets.organizationId, organizationId),
          eq(organizationWallets.isActive, true)
        )
      )
      .returning();

    if (deletedWallet.length === 0) {
      return NextResponse.json(
        { error: "No wallet found to delete" },
        { status: 404 }
      );
    }

    // 3. Delete associated Web3 integration record only if no wallet remains
    const remaining = await db
      .select({ id: organizationWallets.id })
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, organizationId))
      .limit(1);

    if (remaining.length === 0) {
      await db
        .delete(integrations)
        .where(
          and(
            eq(integrations.organizationId, organizationId),
            eq(integrations.type, "web3")
          )
        );
    }

    return NextResponse.json({
      success: true,
      message: "Wallet deleted successfully",
    });
  } catch (error) {
    return apiError(error, "Failed to delete wallet");
  }
}
