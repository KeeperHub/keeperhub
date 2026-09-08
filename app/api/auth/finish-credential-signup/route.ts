import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accounts, users } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { verifyPassword } from "@/lib/password";
import {
  buildPendingSignupSetCookie,
  encodePendingSignupCookie,
} from "@/lib/pending-signup-cookie";
import { resolveClientIpFromHeaders } from "@/lib/security/login-risk";
import { checkCredentialAttemptRateLimit } from "../_lib/credential-attempt-rate-limit";

/**
 * Bridges credential signup (signUp.email + emailOtp.verifyEmail) to
 * TOTP enrollment without ever minting a session. Called from the
 * auth dialog after the user types the signup OTP and Better Auth
 * flips users.email_verified = true. We do NOT call signIn.email
 * here; instead we issue a signed pending_signup_mfa cookie that
 * only unlocks /enroll-mfa. The session is created for the first
 * time inside /api/user/totp/enroll, atomically with the enrollment
 * commit, so no usable session exists until the user has TOTP.
 *
 * Validation:
 *   - User must exist by email.
 *   - users.email_verified must be true (the verifyEmail must have
 *     already succeeded; this endpoint won't mint a pending cookie
 *     for an unverified address).
 *   - users.two_factor_enabled must be false. If the user is already
 *     enrolled, this is the wrong endpoint - they should use the
 *     strict-signin atomic chain to actually sign in.
 *   - Password must match the credential account. We re-verify here
 *     because the cookie cannot be issued solely on email control;
 *     ownership of the credential is the second proof.
 */

type Body = {
  email?: string;
  password?: string;
};

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[finish-credential-signup] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/auth/finish-credential-signup" }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: 500 }
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
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!(email && password)) {
    return NextResponse.json(
      {
        error: "Email and password are required",
        code: "missing_credentials",
      },
      { status: 400 }
    );
  }

  // F-013 / KEEP-738: this route re-verifies the credential password and
  // returns a distinguishable 401 vs 200, so it is a password oracle unless
  // throttled. Limit per-email (brute-forcing one account) and per-IP (email
  // enumeration spray) before any password comparison. Buckets are shared with
  // strict-signin/start (the sibling oracle) so hopping between the two routes
  // does not grant a fresh allowance for the same target.
  const clientIp = resolveClientIpFromHeaders(request.headers) ?? "unknown";
  const rateLimit = checkCredentialAttemptRateLimit(email, clientIp);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many attempts. Wait and try again.",
        code: "rate_limited",
        retryAfter: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      }
    );
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid sign-up state", code: "invalid_state" },
      { status: 401 }
    );
  }
  if (!user.emailVerified) {
    return NextResponse.json(
      { error: "Verify your email first", code: "email_not_verified" },
      { status: 401 }
    );
  }
  if (user.twoFactorEnabled === true) {
    return NextResponse.json(
      {
        error: "Account already has TOTP; use the sign-in flow instead.",
        code: "already_enrolled",
      },
      { status: 409 }
    );
  }

  const [credentialAccount] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))
    )
    .limit(1);
  if (!credentialAccount?.password) {
    // No credential row means the address belongs to an OAuth-only account, so
    // no password will ever satisfy this route. Say so instead of returning the
    // generic invalid_state the caller can only retry into forever. The dialog
    // routes around this before ever reaching here; this is the backstop for a
    // direct caller, which discloses no more than /api/auth/signup-conflict.
    return NextResponse.json(
      {
        error: "This email is registered with a social login. Sign in with it.",
        code: "oauth_account",
      },
      { status: 401 }
    );
  }
  const passwordOk = await verifyPassword(password, credentialAccount.password);
  if (!passwordOk) {
    return NextResponse.json(
      { error: "Invalid sign-up state", code: "invalid_state" },
      { status: 401 }
    );
  }

  // Email is required by the schema for any non-anonymous user, but
  // narrow the type for TypeScript.
  if (!user.email) {
    return NextResponse.json(
      { error: "Invalid sign-up state", code: "invalid_state" },
      { status: 401 }
    );
  }

  const pendingValue = encodePendingSignupCookie(
    {
      userId: user.id,
      email: user.email,
      provider: "credential",
      redirect: "/",
    },
    secret
  );
  const response = NextResponse.json({
    ok: true,
    redirect: "/enroll-mfa",
  });
  response.headers.append(
    "Set-Cookie",
    buildPendingSignupSetCookie(pendingValue)
  );
  return response;
}
