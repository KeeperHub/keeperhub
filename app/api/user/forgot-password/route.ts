import { randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  accounts,
  apiKeys,
  deviceCode,
  mcpOauthAuthCodes,
  mcpOauthRefreshTokens,
  sessions,
  users,
  verifications,
} from "@/lib/db/schema";
import { sendOAuthPasswordResetEmail, sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { hashPassword } from "@/lib/password";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveTrustedClientIp } from "@/lib/security/trusted-proxies";
import { generateId } from "@/lib/utils/id";
import { checkForgotPasswordRateLimit } from "./_lib/rate-limit";

const OAUTH_PROVIDERS = ["github", "google"];
const OTP_EXPIRY_MINUTES = 5;

function generateOTP(): string {
  return randomInt(100_000, 999_999).toString();
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function encryptOtp(otp: string, secret: string): Promise<string> {
  const ciphertext = await symmetricEncrypt({ key: secret, data: otp });
  return `${ciphertext}:0`;
}

async function matchEncryptedOtp(
  storedValue: string,
  providedOtp: string,
  secret: string
): Promise<boolean> {
  const ciphertext = storedValue.split(":")[0];
  if (!ciphertext) {
    return false;
  }
  try {
    const decrypted = await symmetricDecrypt({ key: secret, data: ciphertext });
    return constantTimeEquals(decrypted, providedOtp);
  } catch {
    return false;
  }
}

/**
 * POST /api/user/forgot-password
 * Handles both request (send OTP) and reset (verify OTP + new password) flows
 * based on the action parameter in the request body
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      action?: "request" | "reset";
      email?: string;
      otp?: string;
      newPassword?: string;
    };

    const { action, email } = body;

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // KEEP-625: rate limit BOTH legs of the flow. The /request leg
    // mints reset codes (DoS / cost surface) and the /reset leg is
    // where a stolen code is actually consumed; throttling both
    // closes brute-force and email-flood paths.
    const ip = resolveTrustedClientIp(
      request,
      request.headers.get("x-real-ip")
    );
    const limit = checkForgotPasswordRateLimit(normalizedEmail, ip);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error: `Too many requests. Try again in ${limit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        }
      );
    }

    if (action === "reset") {
      return handleReset(normalizedEmail, body.otp, body.newPassword, request);
    }

    // Default to request action
    return handleRequest(normalizedEmail);
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[Forgot Password] Failed to process request:",
      error,
      {
        endpoint: "/api/user/forgot-password",
        status_code: "500",
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to process request",
      },
      { status: 500 }
    );
  }
}

async function handleRequest(email: string): Promise<NextResponse> {
  // Find user by email
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  // Always return success to prevent email enumeration
  if (!user) {
    return NextResponse.json({
      success: true,
      message: "Check your inbox for the reset code.",
    });
  }

  // Check if user has a credential account
  const userAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, user.id));

  const credentialAccount = userAccounts.find(
    (acc) => acc.providerId === "credential"
  );

  // If user only has OAuth, send a helpful email instead. Pick the
  // OAuth account they most recently signed in with so the reminder
  // names the provider they actually used. Before this fix,
  // multi-linked accounts (Google + GitHub) named whichever was first
  // in OAUTH_PROVIDERS, which surfaced "uses GitHub" to users who had
  // been signing in with Google.
  if (!credentialAccount) {
    const mostRecentOauth = userAccounts
      .filter((acc) => OAUTH_PROVIDERS.includes(acc.providerId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    if (mostRecentOauth) {
      const providerName =
        mostRecentOauth.providerId.charAt(0).toUpperCase() +
        mostRecentOauth.providerId.slice(1);
      await sendOAuthPasswordResetEmail({ email, providerName });
    }

    return NextResponse.json({
      success: true,
      message: "Check your inbox for the reset code.",
    });
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[Forgot Password] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/forgot-password" }
    );
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  const otp = generateOTP();
  const storedValue = await encryptOtp(otp, secret);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Wipe any prior in-flight OTP for this identifier; the rate limit
  // upstream already prevents spam. The bare-email identifier is only
  // used by this route, so this doesn't collide with better-auth's
  // prefixed identifiers (sign-in-otp-..., etc.).
  await db.delete(verifications).where(eq(verifications.identifier, email));

  await db.insert(verifications).values({
    id: generateId(),
    identifier: email,
    value: storedValue,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Send OTP email. We intentionally do NOT propagate a send failure
  // to the response: the row is already in `verifications`, the
  // per-email/per-IP rate limit upstream has already debited, and a
  // 500 here would also leak the "this email exists" bit that the
  // earlier user-not-found / OAuth-only branches go out of their way
  // to hide. sendVerificationOTP already logs failures via
  // logUserError so observability is not lost.
  await sendVerificationOTP({
    email,
    otp,
    type: "forget-password",
  });

  return NextResponse.json({
    success: true,
    message: "Check your inbox for the reset code.",
  });
}

async function handleReset(
  email: string,
  otp: string | undefined,
  newPassword: string | undefined,
  request: Request
): Promise<NextResponse> {
  if (!(otp && newPassword)) {
    return NextResponse.json(
      { error: "OTP and new password are required" },
      { status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[Forgot Password] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/forgot-password" }
    );
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  const verification = await db.query.verifications.findFirst({
    where: and(
      eq(verifications.identifier, email),
      gt(verifications.expiresAt, new Date())
    ),
  });

  if (
    !(
      verification && (await matchEncryptedOtp(verification.value, otp, secret))
    )
  ) {
    return NextResponse.json(
      { error: "Invalid or expired verification code" },
      { status: 400 }
    );
  }

  // Find user
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Find credential account
  const credentialAccount = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.userId, user.id),
      eq(accounts.providerId, "credential")
    ),
  });

  if (!credentialAccount) {
    return NextResponse.json(
      { error: "This account uses social login and cannot reset password" },
      { status: 400 }
    );
  }

  // TOTP is deliberately not required here. The reset mints no session and
  // leaves the user's enrolled factor intact, so the login gate in lib/auth.ts
  // still demands the second factor before any usable session is issued.

  // Hash the new password, drop the consumed reset code, and revoke every
  // user-scoped credential in a single transaction. A reset is a recovery
  // path the user may be invoking precisely because they lost control of the
  // account, so nothing minted before the reset may survive it. Sessions alone
  // are not enough: API keys, MCP refresh tokens, auth codes, and device codes
  // each authenticate standalone with no password or session, so a stolen one
  // would outlive the reset. The reset flow itself mints no session, so the
  // user signs in fresh.
  //
  // Organization API keys are deliberately NOT revoked here. They are
  // org-owned, not user-owned (created_by records provenance, not ownership),
  // and minting one already requires admin/owner role plus dual-factor, so a
  // password reset is the wrong lever: it would take down the org's running
  // automation on a routine, usually-benign event. Genuine account compromise
  // is handled by account deactivation, whose cascade (drizzle/0085) revokes
  // org keys; an exfiltrated key is revoked per-key via /api/keys/[keyId].
  const hashedPassword = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(accounts.id, credentialAccount.id));

    await tx.delete(verifications).where(eq(verifications.id, verification.id));

    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(apiKeys).where(eq(apiKeys.userId, user.id));
    await tx
      .delete(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.userId, user.id));
    await tx
      .delete(mcpOauthAuthCodes)
      .where(eq(mcpOauthAuthCodes.userId, user.id));
    await tx.delete(deviceCode).where(eq(deviceCode.userId, user.id));
  });

  await recordAuditEvent({
    actor: { userId: user.id, organizationId: null, authMethod: "unknown" },
    action: "password.reset",
    resourceType: "user",
    resourceId: user.id,
    metadata: buildAuditMetadata(request),
  });

  return NextResponse.json({
    success: true,
    message: "Password has been reset successfully",
  });
}
