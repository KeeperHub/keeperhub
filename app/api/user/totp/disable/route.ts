import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { STEP_UP_ACTIONS } from "@/lib/mfa/step-up-policy";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

type RequestBody = {
  code?: string;
  emailOtp?: string;
  signature?: string;
};

/**
 * POST /api/user/totp/disable
 *
 * Disables TOTP for the signed-in user. Gated by requireDualFactor
 * (authenticator + email OTP) so a stolen session plus one factor
 * cannot lower the security floor. The same dual-factor primitive
 * we use for withdraw / export-key / api-keys applies here because
 * disabling MFA is at least as high-impact as those actions.
 *
 * Better Auth's built-in /two-factor/disable requires a password and
 * is unusable for our OAuth / email-OTP users, hence the custom
 * endpoint.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (isAnonymousUserShape(session.user)) {
    return NextResponse.json(
      { error: "Sign in with a real account" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const emailOtp =
    typeof body.emailOtp === "string" ? body.emailOtp.trim() : "";
  const signature =
    typeof body.signature === "string" ? body.signature.trim() : undefined;

  const stepUp = await requireStepUp({
    userId: session.user.id,
    email: session.user.email,
    action: STEP_UP_ACTIONS.totpDisable,
    code,
    emailOtp,
    signature,
    headers: request.headers,
  });
  if (!stepUp.ok) {
    return stepUpErrorResponse(stepUp);
  }

  const userId = session.user.id;
  try {
    await db.delete(twoFactorTable).where(eq(twoFactorTable.userId, userId));
    await db
      .update(users)
      .set({ twoFactorEnabled: false })
      .where(eq(users.id, userId));
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Disable] Failed to delete enrollment",
      error,
      { endpoint: "/api/user/totp/disable", user_id: userId }
    );
    return NextResponse.json(
      { error: "Failed to disable TOTP" },
      { status: 500 }
    );
  }

  await recordAuditEvent({
    actor: { userId, organizationId: null, authMethod: "session" },
    action: "totp.disabled",
    resourceType: "user",
    resourceId: userId,
    metadata: buildAuditMetadata(request),
  });

  return NextResponse.json({ status: "ok" });
}
