import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  hashSessionToken,
  signSessionCookieValue,
} from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  dualFactorErrorResponse,
  requireDualFactor,
} from "@/lib/mfa/dual-factor";
import {
  buildPendingOauthMfaClearCookie,
  decodePendingOauthMfaCookie,
  readPendingOauthMfaCookie,
} from "@/lib/oauth-mfa-cookie";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";
import { resolveSigninDevice } from "@/lib/security/device-trust";
import {
  cacheTrustedCountry,
  resolveCfCountry,
  resolveClientIpFromHeaders,
  upsertTrustedCountry,
} from "@/lib/security/login-risk";

/**
 * Finishes the deferred OAuth sign-in.
 *
 * The /api/auth/callback/<provider> wrapper destroyed the session
 * Better Auth would have minted for a TOTP-enrolled user and replaced
 * it with a signed `pending_oauth_mfa` cookie that points back at the
 * user id. This endpoint accepts that cookie plus both MFA factors
 * (TOTP + email OTP), verifies them atomically via requireDualFactor,
 * and only then writes a session row + sets the real session cookie.
 *
 * The pending cookie alone carries no auth power. The session cookie
 * never exists during the in-between window. So a stolen cookie in
 * either direction is useless without both factors.
 */
type Body = {
  code?: string;
  emailOtp?: string;
};

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildSessionSetCookie(token: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[oauth-mfa-finalize] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/auth/oauth-mfa-finalize" }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: 500 }
    );
  }

  const cookieValue = readPendingOauthMfaCookie(request.headers);
  if (!cookieValue) {
    return NextResponse.json(
      { error: "No pending OAuth verification", code: "no_pending_mfa" },
      { status: 401 }
    );
  }
  const decoded = decodePendingOauthMfaCookie(cookieValue, secret);
  if (!decoded.ok) {
    return NextResponse.json(
      {
        error:
          decoded.reason === "expired"
            ? "Verification window expired. Sign in again."
            : "Invalid verification state. Sign in again.",
        code: decoded.reason,
      },
      { status: 401 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "bad_body" },
      { status: 400 }
    );
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const emailOtp =
    typeof body.emailOtp === "string" ? body.emailOtp.trim() : "";

  const dual = await requireDualFactor({
    userId: decoded.payload.userId,
    email: decoded.payload.email,
    action: "oauth_signin",
    code,
    emailOtp,
    headers: request.headers,
  });
  if (!dual.ok) {
    return dualFactorErrorResponse(dual);
  }

  // Both factors verified. Mint a real session for the user. The
  // wrapWithSessionTokenHash adapter hashes the token before storage
  // when called through Better Auth's adapter API, but we are
  // inserting via Drizzle directly here, so we hash explicitly.
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
  const sessionId = `sess_${randomBytes(16).toString("base64url")}`;
  const userAgent = request.headers.get("user-agent") ?? null;
  const ipAddress = resolveClientIpFromHeaders(request.headers);

  try {
    await db.insert(sessions).values({
      id: sessionId,
      userId: decoded.payload.userId,
      token: tokenHash,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress,
      userAgent,
      requiresMfa: false,
      mfaVerifiedAt: new Date(),
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[oauth-mfa-finalize] Failed to insert session row",
      err,
      {
        endpoint: "/api/auth/oauth-mfa-finalize",
        user_id: decoded.payload.userId,
      }
    );
    return NextResponse.json(
      { error: "Failed to create session", code: "session_create_failed" },
      { status: 500 }
    );
  }

  // OAuth finalize is the full dual-factor (TOTP + email OTP) equivalent of
  // /verify-ip, and this path mints the session directly without the
  // country gate. Record the CF country as trusted so the next request
  // isn't bounced to /verify-ip for a redundant step-up.
  const country = await resolveCfCountry();
  if (country) {
    await upsertTrustedCountry(decoded.payload.userId, country);
    await cacheTrustedCountry(decoded.payload.userId, country);
  }

  const response = NextResponse.json({
    ok: true,
    redirect: sanitizeNextPath(decoded.payload.redirect),
  });
  response.headers.append(
    "Set-Cookie",
    buildSessionSetCookie(
      signSessionCookieValue(rawToken, secret),
      DEFAULT_SESSION_TTL_MS
    )
  );
  response.headers.append("Set-Cookie", buildPendingOauthMfaClearCookie());
  const deviceSetCookie = await resolveSigninDevice({
    userId: decoded.payload.userId,
    email: decoded.payload.email,
    country,
    request,
  });
  if (deviceSetCookie) {
    response.headers.append("Set-Cookie", deviceSetCookie);
  }
  return response;
}
