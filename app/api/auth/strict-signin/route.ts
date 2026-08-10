import { timingSafeEqual } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  readAllSetCookies,
  setCookiesToCookieHeader,
} from "@/lib/auth-cookie-chain";
import { hashSessionToken } from "@/lib/auth-session-token-hash";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  twoFactor as twoFactorTable,
  users,
  verifications,
} from "@/lib/db/schema";
import { ApiErrorCodes, apiError } from "@/lib/errors/api-envelope";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
} from "@/lib/mfa/dual-factor-rate-limit";
import { verifyPassword } from "@/lib/password";
import {
  buildPendingIpSetCookie,
  encodePendingIpCookie,
} from "@/lib/pending-ip-cookie";
import { resolveSigninDevice } from "@/lib/security/device-trust";
import { assessCountryTrust } from "@/lib/security/login-risk";
import { verifyUserTotp } from "@/lib/security/totp-verify";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

/**
 * Read the raw session token Better Auth wrote into one of the
 * Set-Cookie headers returned by verifyTOTP. Better Auth signs the
 * cookie via hono's setSignedCookie, so the cookie value is
 * `<rawToken>.<base64HmacSignature>`. We strip the signature suffix
 * because `sessions.token` stores `hashSessionToken(rawToken)` and
 * we need the raw token to reproduce that hash.
 */
function extractNewSessionToken(setCookies: readonly string[]): string | null {
  for (const raw of setCookies) {
    const firstPair = raw.split(";")[0]?.trim();
    if (!firstPair) {
      continue;
    }
    const eqIdx = firstPair.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = firstPair.slice(0, eqIdx);
    const value = firstPair.slice(eqIdx + 1);
    if ((SESSION_COOKIE_NAMES as readonly string[]).includes(name)) {
      const decoded = decodeURIComponent(value);
      const dotIdx = decoded.lastIndexOf(".");
      return dotIdx > 0 ? decoded.slice(0, dotIdx) : decoded;
    }
  }
  return null;
}

/**
 * Atomic strict dual-factor sign-in.
 *
 * Better Auth's stock flow falls down in two ways for our mandate:
 *
 *   1. `/sign-in/email-otp` mints a session as soon as the inbox code
 *      is verified. There is no TOTP gate on that path, so a caller
 *      who can read the encrypted OTP from the verifications row (DB
 *      read + BETTER_AUTH_SECRET) can sign in without TOTP.
 *   2. `/sign-in/email` -> `/two-factor/verify-totp` is the password
 *      + TOTP path, but it does not require an email OTP step. A
 *      stolen authenticator alone is sufficient.
 *
 * This endpoint requires ALL THREE factors in a single atomic
 * request. No session row is created unless password, email OTP and
 * TOTP all pass. Validations are done directly against the DB so we
 * never touch Better Auth's session machinery until every factor has
 * been confirmed; only then do we chain `signInEmail` + `verifyTOTP`
 * server-side to mint the session cookie and relay it back.
 *
 * The email-OTP row stays untouched on failure, so the user can
 * retry with the same code; on success the row is consumed.
 */

type Body = {
  email?: string;
  password?: string;
  emailOtp?: string;
  totpCode?: string;
};

function badRequest(
  request: Request,
  detail: string,
  code: string
): NextResponse {
  return apiError({
    status: HttpStatus.BAD_REQUEST,
    code,
    detail,
    requestHeaders: request.headers,
  });
}

function unauthorized(
  request: Request,
  detail: string,
  code: string
): NextResponse {
  return apiError({
    status: HttpStatus.UNAUTHORIZED,
    code,
    detail,
    requestHeaders: request.headers,
  });
}

function serverError(
  request: Request,
  detail: string,
  code: string
): NextResponse {
  return apiError({
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code,
    detail,
    requestHeaders: request.headers,
  });
}

async function validateEmailOtp(
  email: string,
  providedOtp: string,
  serverSecret: string
): Promise<{ ok: true; rowId: string } | { ok: false }> {
  const identifier = `sign-in-otp-${email}`;
  const [row] = await db
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifier),
        gt(verifications.expiresAt, new Date())
      )
    )
    .orderBy(desc(verifications.expiresAt))
    .limit(1);
  if (!row) {
    return { ok: false };
  }
  // Better Auth's emailOTP plugin stores values as `<encrypted>:<keyVersion>`
  // when storeOTP is "encrypted". The version suffix isn't part of the
  // ciphertext, so strip it before passing to symmetricDecrypt.
  const ciphertext = row.value.split(":")[0];
  try {
    const decrypted = await symmetricDecrypt({
      key: serverSecret,
      data: ciphertext,
    });
    if (!constantTimeEquals(decrypted, providedOtp)) {
      return { ok: false };
    }
    return { ok: true, rowId: row.id };
  } catch {
    return { ok: false };
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest(request, "Invalid JSON body", "bad_body");
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const emailOtp = body.emailOtp?.trim() ?? "";
  const totpCode = body.totpCode?.trim() ?? "";

  if (!(email && password)) {
    return badRequest(
      request,
      "Email and password are required",
      "missing_credentials"
    );
  }
  if (emailOtp.length !== 6) {
    return badRequest(request, "Email code is required", "missing_email_otp");
  }
  if (totpCode.length !== 6) {
    return badRequest(
      request,
      "Authenticator code is required",
      "missing_totp"
    );
  }

  // Per-email sliding window. Keys on the lowercased email so an
  // attacker cannot run high-rate TOTP guesses against a known
  // account, and so the counter ticks even when the user-id lookup
  // would have failed (otherwise the endpoint becomes a free
  // unrate-limited brute-force surface for any non-existent email).
  // resetDualFactor at the success branches wipes the window so a
  // confused user with typos still gets to land.
  const rateLimit = checkDualFactorRateLimit(email, "strict_signin");
  if (!rateLimit.allowed) {
    return apiError({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: ApiErrorCodes.RATE_LIMITED,
      detail: "Too many attempts. Wait and try again.",
      requestHeaders: request.headers,
      headers: { "Retry-After": String(rateLimit.retryAfter) },
    });
  }

  const serverSecret = process.env.BETTER_AUTH_SECRET;
  if (!serverSecret) {
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[strict-signin] BETTER_AUTH_SECRET missing",
      new Error("BETTER_AUTH_SECRET missing"),
      { endpoint: "/api/auth/strict-signin" }
    );
    return serverError(request, "Server misconfigured", "server_misconfigured");
  }

  // 1. Look up the user. Single not-found-or-mismatch response so this
  // endpoint cannot be used as a user-enumeration oracle.
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    return unauthorized(request, "Invalid sign-in", "invalid_signin");
  }

  // 2. Validate password against the user's credential account.
  const [credentialAccount] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(
      and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential"))
    )
    .limit(1);
  if (!credentialAccount?.password) {
    return unauthorized(request, "Invalid sign-in", "invalid_signin");
  }
  const passwordOk = await verifyPassword(password, credentialAccount.password);
  if (!passwordOk) {
    return unauthorized(request, "Invalid sign-in", "invalid_signin");
  }

  // 3. Validate the email OTP. Look-up only; do NOT consume yet.
  const emailOtpResult = await validateEmailOtp(email, emailOtp, serverSecret);
  if (!emailOtpResult.ok) {
    return unauthorized(request, "Invalid email code", "invalid_email_otp");
  }

  // 4. Validate TOTP against the user's two_factor row.
  const [totpRow] = await db
    .select({ secret: twoFactorTable.secret })
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, user.id))
    .limit(1);
  if (!totpRow) {
    return unauthorized(
      request,
      "Two-factor not configured on this account",
      "totp_not_configured"
    );
  }
  const totpOk = await verifyUserTotp(totpRow.secret, totpCode, serverSecret);
  if (!totpOk) {
    return unauthorized(request, "Invalid authenticator code", "invalid_totp");
  }

  // Three factors are now valid but we have not minted a session
  // yet. Consult assessCountryTrust before doing so. If the request
  // comes from a country this user has never signed in from, defer the
  // session: consume the email-OTP row, set a signed `pending_ip_verify`
  // cookie carrying the resolved identity + full IP, and route the user
  // to /verify-ip where they must satisfy another email+TOTP dual
  // factor. No session row exists in between, so a stolen cookie alone
  // cannot unlock the account from a new country. assessCountryTrust
  // returns trusted=true for the user's first-ever attestation and for
  // requests that did not arrive via Cloudflare (no_cf), so local dev
  // and self-hosted setups still sign in normally.
  const countryTrust = await assessCountryTrust(user.id);
  // A CF-attested country always arrives with a CF-Connecting-IP, so an
  // untrusted country implies a non-null IP to bind the verify exchange to.
  // Guard on it anyway: without an IP we cannot pin the replay, so fall
  // through to a normal mint rather than issue an unbindable verify cookie.
  if (!countryTrust.trusted && countryTrust.country && countryTrust.ip) {
    try {
      await db
        .delete(verifications)
        .where(eq(verifications.id, emailOtpResult.rowId));
    } catch (err) {
      logSystemError(
        ErrorCategory.DATABASE,
        "[strict-signin] failed to consume email OTP row before /verify-ip handoff",
        err,
        { endpoint: "/api/auth/strict-signin", user_id: user.id }
      );
    }
    const pendingCookieValue = encodePendingIpCookie(
      {
        userId: user.id,
        email,
        ip: countryTrust.ip,
        country: countryTrust.country,
        redirect: "/",
      },
      serverSecret
    );
    resetDualFactor(email, "strict_signin");
    const response = NextResponse.json({ ok: true, redirect: "/verify-ip" });
    response.headers.append(
      "set-cookie",
      buildPendingIpSetCookie(pendingCookieValue)
    );
    return response;
  }

  // 5. All three factors verified. Chain Better Auth's standard flow
  // to mint the session cookie before consuming the email-OTP row.
  // signInEmail mints a two_factor cookie for TOTP-enrolled users;
  // we forward those Set-Cookie values into verifyTOTP, which
  // completes the flow and returns the session cookie. The OTP row
  // is only deleted AFTER both calls succeed so a transient Better
  // Auth failure leaves the row in place and the user can retry
  // instead of being permanently locked out with an
  // invalid_email_otp loop.
  let twoFactorSetCookies: string[] = [];
  try {
    const signInRes = await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      returnHeaders: true,
    });
    twoFactorSetCookies = readAllSetCookies(signInRes.headers);
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin] signInEmail chain failed after password validation",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
    return serverError(
      request,
      "Sign-in failed at session step",
      "session_failed"
    );
  }
  if (twoFactorSetCookies.length === 0) {
    return serverError(
      request,
      "Sign-in failed at session step",
      "session_failed"
    );
  }

  // Build a Cookie header from every Set-Cookie value returned by
  // signInEmail and pass it into verifyTOTP. The session-clearing
  // cookies ride along harmlessly; verifyTOTP reads only the
  // two_factor cookie. Using the Set-Cookie array directly avoids
  // the parse step that previously broke on production's
  // `__Secure-*` cookie names.
  const chainedHeaders = new Headers(request.headers);
  chainedHeaders.set("cookie", setCookiesToCookieHeader(twoFactorSetCookies));

  let sessionSetCookies: string[] = [];
  try {
    const totpRes = await auth.api.verifyTOTP({
      body: { code: totpCode },
      headers: chainedHeaders,
      returnHeaders: true,
    });
    sessionSetCookies = readAllSetCookies(totpRes.headers);
  } catch (err) {
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin] verifyTOTP chain failed after TOTP validation",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
    return serverError(
      request,
      "Sign-in failed at session step",
      "session_failed"
    );
  }
  if (sessionSetCookies.length === 0) {
    return serverError(
      request,
      "Sign-in failed at session step",
      "session_failed"
    );
  }

  // The session.create.before hook in lib/auth.ts stamps requires_mfa
  // = true on every new session for users with two_factor_enabled.
  // That gate is for the legacy single-factor sign-in path;
  // strict-signin has already verified password + email OTP + TOTP
  // atomically, so the freshly minted session is fully MFA-verified
  // and should not be bounced to /verify-mfa for a redundant step-up.
  //
  // Scope the clear to the new session row by hashing the raw token
  // from the just-emitted Set-Cookie. A WHERE on user_id would lift
  // the gate on every other session this user has, including any
  // pending step-up sessions sitting unverified on another browser.
  const newRawToken = extractNewSessionToken(sessionSetCookies);
  if (newRawToken) {
    try {
      await db
        .update(sessions)
        .set({ requiresMfa: false, mfaVerifiedAt: new Date() })
        .where(eq(sessions.token, hashSessionToken(newRawToken)));
    } catch (err) {
      logSystemError(
        ErrorCategory.AUTH,
        "[strict-signin] failed to clear requires_mfa after dual-factor verification",
        err,
        { endpoint: "/api/auth/strict-signin", user_id: user.id }
      );
    }
  } else {
    logSystemError(
      ErrorCategory.AUTH,
      "[strict-signin] new session token missing from Set-Cookie",
      new Error("session_token cookie not found"),
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
  }

  // Both Better Auth steps succeeded. Consume the email-OTP row now;
  // if the delete itself fails we still return success since the
  // session is already minted, and the row expires in 5 minutes
  // anyway.
  try {
    await db
      .delete(verifications)
      .where(eq(verifications.id, emailOtpResult.rowId));
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[strict-signin] Failed to consume email OTP row after successful sign-in",
      err,
      { endpoint: "/api/auth/strict-signin", user_id: user.id }
    );
  }

  resetDualFactor(email, "strict_signin");
  const response = NextResponse.json({ ok: true });
  for (const cookie of sessionSetCookies) {
    response.headers.append("set-cookie", cookie);
  }
  // Recognise the browser and warn the owner if this device is new. The
  // country is already trusted at this point (the untrusted-country path
  // returned above), so this is the known-country/new-device case.
  const deviceSetCookie = await resolveSigninDevice({
    userId: user.id,
    email,
    country: countryTrust.country,
    request,
  });
  if (deviceSetCookie) {
    response.headers.append("set-cookie", deviceSetCookie);
  }
  return response;
}
