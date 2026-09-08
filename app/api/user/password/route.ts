import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import { hashPassword, verifyPassword } from "@/lib/password";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

const OAUTH_PROVIDERS = ["github", "google"];

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find user's credential account
    const userAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, session.user.id));

    const credentialAccount = userAccounts.find(
      (acc) => acc.providerId === "credential"
    );

    // Check if user only has OAuth accounts
    const hasOnlyOAuth =
      !credentialAccount &&
      userAccounts.some((acc) => OAUTH_PROVIDERS.includes(acc.providerId));

    if (hasOnlyOAuth) {
      const oauthProvider = userAccounts.find((acc) =>
        OAUTH_PROVIDERS.includes(acc.providerId)
      );
      return NextResponse.json(
        {
          error: `Password is managed by ${oauthProvider?.providerId ?? "your OAuth provider"}. You cannot change it here.`,
        },
        { status: 403 }
      );
    }

    if (!credentialAccount) {
      return NextResponse.json(
        { error: "No password account found" },
        { status: 404 }
      );
    }

    const body = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
      code?: string;
      emailOtp?: string;
    };
    const { currentPassword, newPassword, code, emailOtp } = body;

    if (!(currentPassword && newPassword)) {
      return NextResponse.json(
        { error: "Current password and new password are required" },
        { status: 400 }
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Verify current password
    if (!credentialAccount.password) {
      return NextResponse.json(
        { error: "Account has no password set" },
        { status: 400 }
      );
    }

    const isValid = await verifyPassword(
      currentPassword,
      credentialAccount.password
    );
    if (!isValid) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 }
      );
    }

    // Dual-factor challenge. Phished current password alone must not
    // rotate the account password — TOTP + email OTP together stop
    // the takeover.
    const dual = await requireDualFactor({
      userId: session.user.id,
      email: session.user.email,
      action: "password_change",
      code,
      emailOtp,
      headers: request.headers,
    });
    if (!dual.ok) {
      return dualFactorErrorResponse(dual);
    }

    // Rotate the password and invalidate every other session in a single
    // transaction so a mid-write failure cannot leave the new password set
    // while a previously phished or stolen cookie outlives the change. The
    // session the caller just re-authenticated from is preserved (the ne()
    // guard) so they stay signed in on the device they made the change from;
    // if its id is unavailable we fail secure and drop every session.
    const hashedPassword = await hashPassword(newPassword);
    const currentSessionId = (session.session as { id?: string } | undefined)
      ?.id;
    await db.transaction(async (tx) => {
      await tx
        .update(accounts)
        .set({ password: hashedPassword, updatedAt: new Date() })
        .where(eq(accounts.id, credentialAccount.id));
      await tx
        .delete(sessions)
        .where(
          currentSessionId
            ? and(
                eq(sessions.userId, session.user.id),
                ne(sessions.id, currentSessionId)
              )
            : eq(sessions.userId, session.user.id)
        );
    });

    await recordAuditEvent({
      actor: {
        userId: session.user.id,
        organizationId: null,
        authMethod: "session",
      },
      action: "password.changed",
      resourceType: "user",
      resourceId: session.user.id,
      metadata: buildAuditMetadata(request),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[User Password] Failed to change password:",
      error,
      {
        endpoint: "/api/user/password",
        status_code: "500",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to change password",
      },
      { status: 500 }
    );
  }
}
