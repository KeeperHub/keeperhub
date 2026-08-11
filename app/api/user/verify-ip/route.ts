import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  hashSessionToken,
  signSessionCookieValue,
} from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import {
  sessions,
  twoFactor as twoFactorTable,
  userTrustedCountries,
  verifications,
} from "@/lib/db/schema";
import { sendVerificationOTP } from "@/lib/email";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import {
  buildPendingIpClearCookie,
  decodePendingIpCookie,
  readPendingIpCookie,
} from "@/lib/pending-ip-cookie";
import { sanitizeNextPath } from "@/lib/sanitize-next-path";
import { resolveSigninDevice } from "@/lib/security/device-trust";
import {
  buildRiskFlagsJsonForIp,
  cacheTrustedCountry,
  logIpVerify,
  resolveClientIpFromHeaders,
} from "@/lib/security/login-risk";
import { verifyUserTotp } from "@/lib/security/totp-verify";
import { generateId } from "@/lib/utils/id";
import { isVerifyIpMatch } from "./_lib/ip-match";

/**
 * Completes the deferred dual-factor sign-in for a request that
 * arrived from an IP the user has never signed in from. The atomic
 * sign-in routes (strict-signin, oauth-mfa-finalize) set a signed
 * `pending_ip_verify` cookie and route the user here without
 * minting a session. The cookie alone confers no auth power: a
 * thief who exfiltrates it from another network cannot finish
 * because the IP attested at issue time is bound into the payload
 * and re-checked on every call here.
 *
 * Dual-factor model mirrors lib/mfa/dual-factor.ts but cannot use
 * the `requireDualFactor` helper directly because that primitive
 * verifies TOTP via `auth.api.verifyTOTP`, which requires an
 * existing session. /verify-ip is the one place in the codebase
 * where the user is identified but has no session. We verify TOTP
 * straight against the user's encrypted `two_factor.secret` via
 * `verifyUserTotp`, the same primitive strict-signin uses for the
 * very first authentication.
 */

type Body = {
  code?: string;
  emailOtp?: string;
};

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_OTP_TTL_MINUTES = 5;
const ACTION = "verify_ip";

function buildSessionSetCookie(signedValue: string, ttlMs: number): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Secure-better-auth.session_token"
      : "better-auth.session_token";
  return `${cookieName}=${encodeURIComponent(signedValue)}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

function generateEmailOtp(): string {
  return randomInt(100_000, 999_999).toString();
}

function identifierFor(userId: string): string {
  return `mfa:${ACTION}:${userId}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: Request): Promise<NextResponse> {
  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[verify-ip] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/user/verify-ip" }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }

  const cookieValue = readPendingIpCookie(request.headers);
  if (!cookieValue) {
    logIpVerify("verify-ip:no_pending_ip", { hasCookie: false });
    return NextResponse.json(
      {
        error: "No pending IP verification",
        code: "no_pending_ip",
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }
  const decoded = decodePendingIpCookie(cookieValue, serverSecret);
  if (!decoded.ok) {
    logIpVerify("verify-ip:bad_cookie", { reason: decoded.reason });
    return NextResponse.json(
      {
        error:
          decoded.reason === "expired"
            ? "Verification window expired. Sign in again."
            : "Invalid verification state. Sign in again.",
        code: decoded.reason,
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "bad_body" },
      { status: HttpStatus.BAD_REQUEST }
    );
  }
  const totpCode = typeof body.code === "string" ? body.code.trim() : "";
  const inboxCode =
    typeof body.emailOtp === "string" ? body.emailOtp.trim() : "";

  const rateLimit = checkDualFactorRateLimit(decoded.payload.userId, ACTION);
  if (!rateLimit.allowed) {
    logIpVerify("verify-ip:rate_limited", {
      userId: decoded.payload.userId,
      retryAfter: rateLimit.retryAfter,
    });
    return NextResponse.json(
      {
        error: "Too many attempts. Wait and try again.",
        code: "rate_limited",
        retryAfter: rateLimit.retryAfter,
      },
      {
        status: HttpStatus.TOO_MANY_REQUESTS,
        headers: { "Retry-After": String(rateLimit.retryAfter) },
      }
    );
  }

  const bothPresent = totpCode.length === 6 && inboxCode.length === 6;

  // The email-OTP request is not gated on the IP re-check: the user may
  // request the code from a rotating egress IP. Only the session-minting
  // path below binds to the network pinned in the cookie.
  if (!bothPresent) {
    const otp = generateEmailOtp();
    const encrypted = await symmetricEncrypt({
      key: serverSecret,
      data: otp,
    });
    const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MINUTES * 60 * 1000);
    const identifier = identifierFor(decoded.payload.userId);
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
      email: decoded.payload.email,
      otp,
      type: "confirm-action",
    });
    if (!sent) {
      logIpVerify("verify-ip:email_send_failed", {
        userId: decoded.payload.userId,
        email: decoded.payload.email,
      });
      return NextResponse.json(
        {
          error: "Failed to send confirmation email",
          code: "email_send_failed",
        },
        { status: HttpStatus.SERVICE_UNAVAILABLE }
      );
    }
    logIpVerify("verify-ip:otp_sent", {
      userId: decoded.payload.userId,
      email: decoded.payload.email,
      cookieIp: decoded.payload.ip,
    });
    return NextResponse.json(
      {
        error:
          "Enter the 6-digit code from your authenticator app and the code emailed to you.",
        code: "factors_required",
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  // Both codes present -> session-minting path. Bind the exchange to the
  // network the cookie was issued for: a thief on a different network
  // cannot finish even with valid factors. The full IP is what we store
  // and email, but the replay comparison normalizes both sides to the
  // /24-or-/64 network so a user whose egress IP rotates within their
  // subnet mid-flow isn't bounced.
  const currentRawIp = resolveClientIpFromHeaders(request.headers);
  const ipMatch = isVerifyIpMatch(currentRawIp, decoded.payload.ip);
  logIpVerify("verify-ip:final_check", {
    userId: decoded.payload.userId,
    cookieIp: decoded.payload.ip,
    currentRawIp,
    match: ipMatch,
  });
  if (!ipMatch) {
    logSystemWarn(
      ErrorCategory.AUTH,
      "[verify-ip] ip_mismatch on session-minting attempt",
      new Error("ip_mismatch"),
      {
        endpoint: "/api/user/verify-ip",
        user_id: decoded.payload.userId,
      }
    );
    return NextResponse.json(
      {
        error: "Verification must be completed from the same network.",
        code: "ip_mismatch",
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  const [totpRow] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, decoded.payload.userId))
    .limit(1);
  if (!totpRow) {
    return NextResponse.json(
      {
        error: "Two-factor not configured on this account",
        code: "totp_not_configured",
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }
  const totpOk = await verifyUserTotp(totpRow.secret, totpCode, serverSecret);
  if (!totpOk) {
    return NextResponse.json(
      { error: "Invalid authenticator code", code: "mfa_code_invalid" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  const identifier = identifierFor(decoded.payload.userId);
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
    return NextResponse.json(
      {
        error: "Email code expired. Request a new one.",
        code: "email_code_invalid",
      },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }
  let decryptedOtp: string;
  try {
    decryptedOtp = await symmetricDecrypt({
      key: serverSecret,
      data: row.value,
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[verify-ip] failed to decrypt stored email OTP",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
    return NextResponse.json(
      { error: "Server misconfigured", code: "server_misconfigured" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
  if (!constantTimeEquals(decryptedOtp, inboxCode)) {
    return NextResponse.json(
      { error: "Invalid email code", code: "email_code_invalid" },
      { status: HttpStatus.UNAUTHORIZED }
    );
  }

  // Both factors verified and IP matches the cookie. Consume the
  // email-OTP row, mint a fully-MFA-verified session, and record the
  // IP as trusted for this user. The hash-token wrapper applies to
  // Better Auth's adapter calls, not direct Drizzle inserts, so hash
  // the token explicitly before storing.
  try {
    await db.delete(verifications).where(eq(verifications.id, row.id));
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[verify-ip] failed to consume email OTP row after success",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
  }
  resetDualFactor(decoded.payload.userId, ACTION);

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
  const sessionId = `sess_${randomBytes(16).toString("base64url")}`;
  const userAgent = request.headers.get("user-agent") ?? null;
  const ipAddress = decoded.payload.ip;

  // Capture geolocation for the active-sessions panel. The pending
  // cookie carries the country attested at strict-signin time; the
  // shared helper layers region + city via the IP-to-location
  // provider abstraction and serializes the same JSON shape Better
  // Auth's session.create.before path writes, so downstream readers
  // don't have to special-case rows minted on this path.
  const riskFlagsJson = await buildRiskFlagsJsonForIp(
    ipAddress,
    decoded.payload.country
  );

  const trustedCountry = decoded.payload.country;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(sessions).values({
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
        riskFlagsJson,
      });
      if (trustedCountry) {
        await tx
          .insert(userTrustedCountries)
          .values({
            userId: decoded.payload.userId,
            country: trustedCountry,
          })
          .onConflictDoUpdate({
            target: [userTrustedCountries.userId, userTrustedCountries.country],
            set: { lastSeenAt: new Date() },
          });
      }
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[verify-ip] failed to insert session + trusted country",
      err,
      { endpoint: "/api/user/verify-ip", user_id: decoded.payload.userId }
    );
    return NextResponse.json(
      { error: "Failed to create session", code: "session_create_failed" },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }

  // Warm the shared cache so every replica's next request is a hit, not a DB
  // read. Best-effort; the DB upsert above is the durable source of truth.
  if (trustedCountry) {
    await cacheTrustedCountry(decoded.payload.userId, trustedCountry);
  }

  const response = NextResponse.json({
    ok: true,
    redirect: sanitizeNextPath(decoded.payload.redirect),
  });
  response.headers.append(
    "Set-Cookie",
    buildSessionSetCookie(
      signSessionCookieValue(rawToken, serverSecret),
      DEFAULT_SESSION_TTL_MS
    )
  );
  response.headers.append("Set-Cookie", buildPendingIpClearCookie());
  // Recognise the browser and warn the owner if this device is new.
  const deviceSetCookie = await resolveSigninDevice({
    userId: decoded.payload.userId,
    email: decoded.payload.email,
    country: trustedCountry,
    request,
  });
  if (deviceSetCookie) {
    response.headers.append("Set-Cookie", deviceSetCookie);
  }
  return response;
}
