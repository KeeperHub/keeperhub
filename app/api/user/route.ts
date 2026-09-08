import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import {
  auditFromAuth,
  type DualAuthContext,
  getDualAuthContext,
} from "@/lib/middleware/auth-helpers";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";

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

    const { userId, organizationId } = authContext;
    if (!userId) {
      return NextResponse.json(
        { error: "Auth context missing user. Please recreate the API key." },
        { status: 400 }
      );
    }

    const userData = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        name: true,
        email: true,
        image: true,
        isAnonymous: true,
      },
    });

    if (!userData) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userAccount = await db.query.accounts.findFirst({
      where: eq(accounts.userId, userId),
      columns: {
        providerId: true,
      },
    });

    let walletAddress: string | null = null;
    if (organizationId) {
      try {
        const wallet = await getOrganizationWallet(organizationId);
        walletAddress = wallet.walletAddress;
      } catch {
        walletAddress = null;
      }
    }

    return NextResponse.json({
      ...userData,
      providerId: userAccount?.providerId ?? null,
      walletAddress,
    });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get user", error, {
      endpoint: "/api/user",
      operation: "get",
      ...auditFromAuth(authContext),
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get user",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an OAuth user (can't update profile)
    const userAccount = await db.query.accounts.findFirst({
      where: eq(accounts.userId, session.user.id),
      columns: {
        providerId: true,
      },
    });

    // Block updates for OAuth users (github, google, etc.)
    const oauthProviders = ["github", "google"];
    if (userAccount && oauthProviders.includes(userAccount.providerId)) {
      return NextResponse.json(
        { error: "Cannot update profile for OAuth users" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const updates: { name?: string; email?: string } = {};

    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (body.email !== undefined) {
      updates.email = body.email;
    }

    // Email change is account-takeover surface — if an attacker can
    // swap the email to one they control, every subsequent password-
    // reset path mints them a session as the victim. Require dual-
    // factor (TOTP + email OTP) for the email path specifically. Note:
    // the email OTP is sent to the CURRENT email so the attacker
    // cannot satisfy the inbox factor unless they already control it.
    // Name-only updates skip the gate (low risk, frequent).
    const isEmailChange =
      updates.email !== undefined && updates.email !== session.user.email;
    if (isEmailChange) {
      const dual = await requireDualFactor({
        userId: session.user.id,
        email: session.user.email,
        action: "email_change",
        code: typeof body.code === "string" ? body.code : undefined,
        emailOtp: typeof body.emailOtp === "string" ? body.emailOtp : undefined,
        headers: request.headers,
      });
      if (!dual.ok) {
        return dualFactorErrorResponse(dual);
      }
    }

    await db.update(users).set(updates).where(eq(users.id, session.user.id));

    if (isEmailChange) {
      await recordAuditEvent({
        actor: {
          userId: session.user.id,
          organizationId: null,
          authMethod: "session",
        },
        action: "email.changed",
        resourceType: "user",
        resourceId: session.user.id,
        before: { email: session.user.email },
        after: { email: updates.email },
        metadata: buildAuditMetadata(request),
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to update user", error, {
      endpoint: "/api/user",
      operation: "update",
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to update user",
      },
      { status: 500 }
    );
  }
}
