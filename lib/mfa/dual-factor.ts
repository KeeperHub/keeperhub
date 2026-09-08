import { randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable, verifications } from "@/lib/db/schema";
import { sendVerificationOTP } from "@/lib/email";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import { verifyUserTotp } from "@/lib/security/totp-verify";
import { generateId } from "@/lib/utils/id";

/**
 * Constant-time compare for 6-digit OTP values. Both sides are
 * Buffer-encoded under the same charset; length check up front
 * because timingSafeEqual throws on mismatched lengths.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Dual-factor gate for the highest-risk actions. Both factors must
 * succeed in the same request before the action runs:
 *
 *  1. TOTP (`code` field): proves possession of the user's authenticator
 *     secret. Verified session-lessly against the user's two_factor row
 *     via verifyUserTotp (see comment at the verify call for why we can
 *     not call auth.api.verifyTOTP from this gate).
 *  2. Email OTP (`emailOtp` field): proves control of the user's
 *     inbox. Stored encrypted in verifications, identified by
 *     `mfa:<action>:<userId>`, 5-minute TTL.
 *
 * Flow:
 *   - First call with neither code present: server mints + emails the
 *     OTP, returns ok=false code=factors_required so the client can
 *     reveal the dual input.
 *   - Subsequent call with both codes: server verifies and consumes
 *     the email OTP row, verifies the TOTP, returns ok=true.
 *   - Either code wrong: returns ok=false with a specific code so the
 *     client can prompt for the right field.
 *
 * The email OTP is encrypted with BETTER_AUTH_SECRET on store and
 * decrypted on compare; a DB-read attacker can't extract a live code
 * without the server secret.
 */

const EMAIL_OTP_TTL_MINUTES = 5;

export type DualFactorOk = { ok: true };
export type DualFactorError = {
  ok: false;
  status: 401 | 429 | 500 | 503;
  error: string;
  code:
    | "factors_required"
    | "mfa_code_invalid"
    | "email_code_invalid"
    | "email_send_failed"
    | "server_misconfigured"
    | "rate_limited";
  retryAfter?: number;
};
export type DualFactorResult = DualFactorOk | DualFactorError;

// Render a requireDualFactor failure as a JSON response. On the rate-limit
// 429 it surfaces the standard Retry-After header so callers don't drop the
// retry hint. This is an anti-abuse limiter, so no remaining-budget headers.
export function dualFactorErrorResponse(error: DualFactorError): NextResponse {
  return NextResponse.json(
    { error: error.error, code: error.code },
    error.status === 429 && error.retryAfter !== undefined
      ? {
          status: error.status,
          headers: { "Retry-After": String(error.retryAfter) },
        }
      : { status: error.status }
  );
}

type DualFactorArgs = {
  userId: string;
  email: string;
  action: string;
  code?: string;
  emailOtp?: string;
  headers: Headers;
};

function generateEmailOtp(): string {
  return randomInt(100_000, 999_999).toString();
}

function identifierFor(userId: string, action: string): string {
  return `mfa:${action}:${userId}`;
}

export async function requireDualFactor(
  args: DualFactorArgs
): Promise<DualFactorResult> {
  const { userId, email, action, code, emailOtp } = args;
  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[DualFactor] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { action }
    );
    return {
      ok: false,
      status: 500,
      error: "Server misconfigured",
      code: "server_misconfigured",
    };
  }

  // Sliding-window guard covers both attack surfaces:
  //   - empty-body floods that mint email OTPs at the victim's inbox
  //   - brute-force guesses against a live verifications row
  // Every entry into requireDualFactor counts toward the window; the
  // counter is wiped on a successful both-factor verify so a typo
  // burst doesn't lock out the legitimate user.
  const rateLimit = checkDualFactorRateLimit(userId, action);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      status: 429,
      error: "Too many attempts. Wait and try again.",
      code: "rate_limited",
      retryAfter: rateLimit.retryAfter,
    };
  }

  const totpCode = typeof code === "string" ? code.trim() : "";
  const inboxCode = typeof emailOtp === "string" ? emailOtp.trim() : "";
  const bothPresent = totpCode.length === 6 && inboxCode.length === 6;

  // Any call that doesn't carry both 6-digit codes mints a fresh
  // email OTP, emails it, and returns factors_required. The client
  // can submit empty codes on first render to trigger the email,
  // then submit again with both codes filled in. Resubmitting with
  // one missing code re-issues the email rather than returning a
  // narrow "you forgot the other field" error, since fewer client
  // states to model, and the user always sees the same prompt.
  if (!bothPresent) {
    const otp = generateEmailOtp();
    const encrypted = await symmetricEncrypt({
      key: serverSecret,
      data: otp,
    });
    const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MINUTES * 60 * 1000);
    const identifier = identifierFor(userId, action);

    // Replace any in-flight OTP for the same (user, action) so the
    // most recent code is the only one accepted.
    await db
      .delete(verifications)
      .where(eq(verifications.identifier, identifier));
    await db.insert(verifications).values({
      id: generateId(),
      identifier,
      value: encrypted,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sent = await sendVerificationOTP({
      email,
      otp,
      type: "confirm-action",
    });
    if (!sent) {
      return {
        ok: false,
        status: 503,
        error: "Failed to send confirmation email",
        code: "email_send_failed",
      };
    }
    return {
      ok: false,
      status: 401,
      error:
        "Enter the 6-digit code from your authenticator app and the code emailed to you.",
      code: "factors_required",
    };
  }

  // Session-less TOTP verify against the user's two_factor row. We can't
  // call auth.api.verifyTOTP from this gate: the OAuth-MFA finalize path
  // runs after interceptOauthCallback has destroyed the session, leaving
  // only the pending_oauth_mfa cookie — verifyTOTP requires either an
  // active session or the TWO_FACTOR_COOKIE_NAME cookie, neither of
  // which exists here. Same approach as the strict-signin route.
  const [tfRow] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, userId))
    .limit(1);
  if (!tfRow) {
    return {
      ok: false,
      status: 401,
      error: "Invalid authenticator code",
      code: "mfa_code_invalid",
    };
  }
  const totpOk = await verifyUserTotp(tfRow.secret, totpCode, serverSecret);
  if (!totpOk) {
    return {
      ok: false,
      status: 401,
      error: "Invalid authenticator code",
      code: "mfa_code_invalid",
    };
  }

  const identifier = identifierFor(userId, action);
  const [row] = await db
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifier),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!row) {
    return {
      ok: false,
      status: 401,
      error: "Email code expired. Request a new one.",
      code: "email_code_invalid",
    };
  }
  let decrypted: string;
  try {
    decrypted = await symmetricDecrypt({ key: serverSecret, data: row.value });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[DualFactor] Failed to decrypt stored email OTP",
      err,
      { action, identifier }
    );
    return {
      ok: false,
      status: 500,
      error: "Server misconfigured",
      code: "server_misconfigured",
    };
  }
  if (!constantTimeEquals(decrypted, inboxCode)) {
    return {
      ok: false,
      status: 401,
      error: "Invalid email code",
      code: "email_code_invalid",
    };
  }

  // Single-use: consume the row once both factors match. Subsequent
  // calls for the same (user, action) must mint a new code.
  await db.delete(verifications).where(eq(verifications.id, row.id));
  resetDualFactor(userId, action);
  return { ok: true };
}
