import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { testEndpointsEnabled } from "@/lib/admin-auth";
import { auth } from "@/lib/auth";
import { readAllSetCookies } from "@/lib/auth-cookie-chain";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { verifyPassword } from "@/lib/password";
import { resolveClientIpFromHeaders } from "@/lib/security/login-risk";
import { checkCredentialAttemptRateLimit } from "../../_lib/credential-attempt-rate-limit";

/**
 * First step of the strict atomic dual-factor sign-in.
 *
 * Validates the password against the user's credential account
 * directly (no cookies set, no Better Auth session machinery
 * touched) and, only on a successful match, triggers the email-OTP
 * send via Better Auth's emailOTP plugin so the standard
 * `sign-in-otp-<email>` verifications row gets seeded with the
 * encrypted code. The user then provides that code, plus their
 * TOTP, to /api/auth/strict-signin (the atomic complete step) which
 * verifies all three factors before any session is created.
 *
 * Password validation is done here rather than client-side because
 * we never want an email OTP minted for an email/password pair the
 * caller cannot prove. That keeps the email-flood surface tight
 * and matches what the atomic /complete endpoint requires.
 *
 * Success response is a uniform shape regardless of whether the
 * email exists, so the endpoint cannot be used as a user-
 * enumeration oracle. Wrong credentials get a 401.
 */

type Body = {
  email?: string;
  password?: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: "bad_body",
      detail: "Invalid JSON body",
      requestHeaders: request.headers,
    });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";

  if (!(email && password)) {
    return apiError({
      status: HttpStatus.BAD_REQUEST,
      code: "missing_credentials",
      detail: "Email and password are required",
      requestHeaders: request.headers,
    });
  }

  // F-013 / KEEP-738: this route verifies the credential password and returns a
  // distinguishable 401 vs 200 (and signs non-TOTP users straight in on a
  // correct password), so it is an unauthenticated password oracle unless
  // throttled. Limit per-email + per-IP before any password comparison; buckets
  // are shared with finish-credential-signup so an attacker cannot get a fresh
  // allowance by hopping between the two routes for the same target.
  const clientIp = resolveClientIpFromHeaders(request.headers) ?? "unknown";
  // The e2e playwright suite signs in repeatedly as a handful of shared test
  // users, which would otherwise exhaust the per-email budget mid-run. Skip the
  // throttle only for authenticated test traffic, gated identically to
  // Better Auth's rateLimitBypassRule (testEndpointsEnabled + a matching
  // X-Test-API-Key) so it stays fully enforced in production.
  const testApiKey = process.env.TEST_API_KEY;
  const isE2eTestTraffic =
    testEndpointsEnabled() &&
    !!testApiKey &&
    request.headers.get("X-Test-API-Key") === testApiKey;
  if (!isE2eTestTraffic) {
    const rateLimit = checkCredentialAttemptRateLimit(email, clientIp);
    if (!rateLimit.allowed) {
      return apiError({
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ApiErrorCodes.RATE_LIMITED,
        detail: "Too many attempts. Wait and try again.",
        requestHeaders: request.headers,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds),
        },
      });
    }
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      twoFactorEnabled: users.twoFactorEnabled,
      deactivatedAt: users.deactivatedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    return apiError({
      status: HttpStatus.UNAUTHORIZED,
      code: "invalid_signin",
      detail: "Invalid sign-in",
      requestHeaders: request.headers,
    });
  }

  const [credentialAccount] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))
    )
    .limit(1);
  if (!credentialAccount?.password) {
    return apiError({
      status: HttpStatus.UNAUTHORIZED,
      code: "invalid_signin",
      detail: "Invalid sign-in",
      requestHeaders: request.headers,
    });
  }

  const passwordOk = await verifyPassword(password, credentialAccount.password);
  if (!passwordOk) {
    return apiError({
      status: HttpStatus.UNAUTHORIZED,
      code: "invalid_signin",
      detail: "Invalid sign-in",
      requestHeaders: request.headers,
    });
  }

  if (user.deactivatedAt) {
    return apiError({
      status: HttpStatus.FORBIDDEN,
      code: "account_deactivated",
      detail: "Your account has been deactivated.",
      requestHeaders: request.headers,
    });
  }

  // The account exists and the password matched, but the email isn't verified.
  // Better Auth's signInEmail would throw here; surface it as a typed signal so
  // the dialog routes to the verification view (where it re-sends the OTP)
  // instead of treating it as a generic 500. The password already matched, so
  // this does not widen account enumeration beyond a correct-password reveal.
  if (!user.emailVerified) {
    return apiError({
      status: HttpStatus.FORBIDDEN,
      code: "email_not_verified",
      detail: "Please verify your email to continue.",
      requestHeaders: request.headers,
    });
  }

  // Users without TOTP enrolled bypass the dual-factor flow. Mint the
  // session directly via Better Auth's signInEmail and forward its
  // session cookies on the response so the client can hard-reload into
  // an authenticated state. Only users with two_factor_enabled=true
  // proceed to the email-OTP + TOTP atomic flow below.
  if (user.twoFactorEnabled !== true) {
    try {
      const signInRes = await auth.api.signInEmail({
        body: { email, password },
        headers: request.headers,
        returnHeaders: true,
      });
      const sessionCookies = readAllSetCookies(signInRes.headers);
      const response = NextResponse.json({ ok: true, signedIn: true });
      for (const cookie of sessionCookies) {
        response.headers.append("Set-Cookie", cookie);
      }
      return response;
    } catch (err) {
      logSystemError(
        ErrorCategory.AUTH,
        "[strict-signin.start] signInEmail failed for non-TOTP user",
        err,
        { endpoint: "/api/auth/strict-signin/start", user_id: user.id }
      );
      return apiError({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: "signin_failed",
        detail: "Sign-in failed",
        requestHeaders: request.headers,
      });
    }
  }

  // Trigger Better Auth's emailOTP sendVerificationOTP server-side so
  // the encrypted `sign-in-otp-<email>` verifications row is seeded
  // for /api/auth/strict-signin to compare against. Calling the plugin
  // API directly avoids a self-fetch over HTTP, which CodeQL flagged
  // as SSRF because `new URL(request.url).origin` reflects the
  // request's Host header.
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "sign-in" },
      headers: request.headers,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin.start] emailOTP send failed",
      err,
      { endpoint: "/api/auth/strict-signin/start", user_id: user.id }
    );
    return apiError({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: "email_send_failed",
      detail: "Failed to send confirmation email",
      requestHeaders: request.headers,
    });
  }

  // No session, no cookie, just a green light to proceed to email
  // OTP entry. The client retains the password locally to submit
  // along with the OTP + TOTP at the atomic complete step.
  return NextResponse.json({ ok: true });
}
