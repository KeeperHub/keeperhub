import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";

type RequestBody = {
  code?: string;
  emailOtp?: string;
  signature?: string;
};

/**
 * POST /api/user/totp/verify-stepup
 *
 * Clears the requires_mfa flag on the caller's session after the user
 * proves possession of both factors (authenticator code + email OTP).
 * Gated by requireDualFactor with action `session_stepup` so a stolen
 * session plus one factor cannot lift the step-up gate.
 *
 * The /verify-mfa page redirects here whenever a session is
 * quarantined by `session.create.before` setting `requires_mfa = true`
 * for a TOTP-enrolled user.
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
    action: "session_stepup",
    code,
    emailOtp,
    signature,
    headers: request.headers,
  });
  if (!stepUp.ok) {
    return stepUpErrorResponse(stepUp);
  }

  try {
    await db
      .update(sessions)
      .set({ requiresMfa: false, mfaVerifiedAt: new Date() })
      .where(eq(sessions.id, session.session.id));
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Verify Stepup] Failed to clear requires_mfa",
      error,
      {
        endpoint: "/api/user/totp/verify-stepup",
        user_id: session.user.id,
        session_id: session.session.id,
      }
    );
    return NextResponse.json(
      { error: "Verification accepted but session update failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ status: "ok" });
}
