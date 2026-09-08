import { randomUUID } from "node:crypto";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { twoFactor as twoFactorTable, users } from "@/lib/db/schema";
import { resolveEnrollMfaCaller } from "@/lib/enroll-mfa-caller";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { requireStepUp, stepUpErrorResponse } from "@/lib/mfa/wallet-step-up";

const ISSUER = "KeeperHub";
const SECRET_LENGTH = 32;
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

type SetupRequest = {
  name?: string;
  code?: string;
  emailOtp?: string;
  signature?: string;
};

type SetupResponse = {
  totpUri: string;
  /**
   * Base32-encoded secret extracted from the otpauth URI's `secret` query
   * parameter. Returned alongside the URI so the enrollment UI can show
   * the user-facing secret for manual authenticator entry without
   * needing to parse the URI itself. Same value as `secret=` in totpUri.
   */
  manualEntryKey: string;
};

const MAX_NAME_LENGTH = 64;

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/**
 * RFC 4648 base32 without padding. The otpauth:// URI requires the
 * `secret=` parameter to be base32-encoded so authenticator apps can
 * decode it back to raw bytes for the HMAC step. Better Auth's
 * verify-totp uses the unencoded secret string directly as the HMAC key;
 * the encode/decode round-trip on the URI is what reconciles both sides.
 */
function base32EncodeUtf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function buildTotpUri(secret: string, account: string): string {
  const encodedIssuer = encodeURIComponent(ISSUER);
  const encodedAccount = encodeURIComponent(account);
  const params = new URLSearchParams({
    secret: base32EncodeUtf8(secret),
    issuer: ISSUER,
    digits: TOTP_DIGITS.toString(),
    period: TOTP_PERIOD.toString(),
  });
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?${params.toString()}`;
}

/**
 * POST /api/user/totp/setup
 *
 * Generates a TOTP secret + backup codes for the signed-in user and
 * stores them (encrypted) in the two_factor table. Returns the
 * otpauth:// URI for the client to render as a QR code and the
 * one-time-display plaintext backup codes.
 *
 * This endpoint bypasses Better Auth's built-in /two-factor/enable
 * because that endpoint requires a password and most of our users sign
 * in via OAuth or email OTP and have no password set. The session
 * cookie itself is sufficient first-factor proof to bootstrap
 * enrollment (it required either OAuth or an email OTP to obtain).
 *
 * users.two_factor_enabled is flipped to true by the plugin's
 * /api/auth/two-factor/verify-totp endpoint on first successful code
 * verification, not here. That keeps the "is the secret good?" check
 * coupled to the user actually proving they can read the QR.
 *
 * Calling this endpoint a second time replaces any existing
 * enrollment. Once the account is fully enrolled
 * (users.two_factor_enabled = true with a two_factor row), that
 * rotation overwrites the live secret and wipes backup codes, so it is
 * gated behind requireDualFactor (authenticator + email OTP) exactly
 * like /disable. First-time and pending-signup enrollment, which have
 * no active second factor to protect yet, mint without that proof.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const caller = await resolveEnrollMfaCaller(request.headers);
  if (caller.kind === "anonymous") {
    if (caller.reason === "anonymous_user") {
      return NextResponse.json(
        { error: "Sign in with a real account to enable two-factor" },
        { status: 403 }
      );
    }
    if (caller.reason === "no_email") {
      return NextResponse.json(
        { error: "Account missing email" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = caller.userId;
  const userEmail = caller.email;

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[TOTP Setup] BETTER_AUTH_SECRET is not configured",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/totp/setup" }
    );
    return NextResponse.json(
      { error: "Server misconfigured" },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as SetupRequest;
  // Name defaults to a sensible label so the manage view always has
  // something to show. Users can edit/rename later from the manage
  // dialog; the setup flow no longer asks up-front to keep enrollment
  // to scan -> verify -> save-codes.
  const name =
    sanitizeName(body.name) ??
    `Authenticator (${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })})`;

  // Re-running /setup on an already-enrolled account overwrites the
  // TOTP secret and wipes backup codes. That is a security-floor
  // mutation as impactful as /disable, so it must carry the same
  // dual-factor proof. First-time and pending-signup enroll (no active
  // second factor yet) are still allowed to mint without proof.
  const [userRow] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [existingFactor] = await db
    .select({ id: twoFactorTable.id })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, userId))
    .limit(1);
  const alreadyEnrolled =
    userRow?.twoFactorEnabled === true && Boolean(existingFactor);
  if (alreadyEnrolled) {
    const stepUp = await requireStepUp({
      userId,
      email: userEmail,
      action: "totp_setup",
      code: typeof body.code === "string" ? body.code.trim() : "",
      emailOtp: typeof body.emailOtp === "string" ? body.emailOtp.trim() : "",
      signature:
        typeof body.signature === "string" ? body.signature.trim() : undefined,
      headers: request.headers,
    });
    if (!stepUp.ok) {
      return stepUpErrorResponse(stepUp);
    }
  }

  try {
    const totpSecret = generateRandomString(SECRET_LENGTH);
    const encryptedSecret = await symmetricEncrypt({
      key: secret,
      data: totpSecret,
    });

    // Atomic upsert via the UNIQUE constraint on two_factor.user_id.
    // Replaces the older DELETE-then-INSERT pattern which could
    // produce duplicate rows under concurrent calls (React StrictMode
    // fires open-effects twice in dev). One enrollment per user.
    // Write the row pending (verified=false). The column defaults to true so
    // sign-in verify never issues a redundant update, but a freshly generated
    // secret has not been confirmed yet: leaving it true makes Better Auth's
    // verify-totp skip its own enable path (it only enables when
    // verified !== true), which strands re-enrollment. Starting false lets that
    // path run on the first correct code, flipping verified + two_factor_enabled
    // together. It returns to true the moment enrollment completes.
    const enrolledAt = new Date();
    await db
      .insert(twoFactorTable)
      .values({
        id: randomUUID(),
        userId,
        secret: encryptedSecret,
        backupCodes: null,
        name,
        enrolledAt,
        verified: false,
      })
      .onConflictDoUpdate({
        target: twoFactorTable.userId,
        set: {
          secret: encryptedSecret,
          backupCodes: null,
          name,
          enrolledAt,
          verified: false,
        },
      });

    const manualEntryKey = base32EncodeUtf8(totpSecret);
    const responseBody: SetupResponse = {
      totpUri: buildTotpUri(totpSecret, userEmail),
      manualEntryKey,
    };
    return NextResponse.json(responseBody);
  } catch (error) {
    logSystemError(
      ErrorCategory.AUTH,
      "[TOTP Setup] Failed to provision TOTP",
      error,
      { endpoint: "/api/user/totp/setup", user_id: userId }
    );
    return NextResponse.json(
      { error: "Failed to provision TOTP" },
      { status: 500 }
    );
  }
}
