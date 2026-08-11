import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed cookie that bridges signup to TOTP enrollment without ever
 * minting a usable session. Set after the user has proven control of
 * the email (credential signup: verified the signup OTP; OAuth
 * signup: the provider already certified the address) but BEFORE
 * they enroll an authenticator. /enroll-mfa reads this cookie and
 * lets the user run the 3-step wizard. /api/user/totp/enroll, on
 * successful first-time verify, atomically writes the session row
 * for the first time and clears this cookie.
 *
 * Threat model:
 *   - Cookie alone carries no auth power. It only unlocks reaching
 *     /enroll-mfa and the enroll endpoint, both of which still
 *     require generating + verifying a TOTP code via the user's own
 *     authenticator app. A stolen cookie cannot mint a session.
 *   - HMAC under BETTER_AUTH_SECRET prevents forgery.
 *   - Embedded expiresAt is checked on every read; we never extend
 *     the bridge window server-side.
 */

const COOKIE_NAME = "pending_signup_mfa";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes - long enough to set up an authenticator.

export type PendingSignupPayload = {
  userId: string;
  email: string;
  /**
   * Provider whose flow created the user. "credential" for signups
   * via signUp.email; the social provider id (e.g. "google",
   * "github") for OAuth signups intercepted in
   * app/api/auth/[...all]/route.ts.
   */
  provider: string;
  /**
   * The path to redirect to after the user finishes enrollment and
   * the session is minted for the first time.
   */
  redirect: string;
  expiresAt: number;
};

export function pendingSignupCookieName(): string {
  return COOKIE_NAME;
}

const BASE64_PADDING_RE = /=+$/;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(BASE64_PADDING_RE, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

export function encodePendingSignupCookie(
  payload: Omit<PendingSignupPayload, "expiresAt">,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const full: PendingSignupPayload = {
    ...payload,
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

export type DecodeResult =
  | { ok: true; payload: PendingSignupPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodePendingSignupCookie(
  cookieValue: string,
  secret: string
): DecodeResult {
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const encoded = cookieValue.slice(0, dot);
  const macClaim = cookieValue.slice(dot + 1);
  const macActual = sign(encoded, secret);
  const macClaimBuf = Buffer.from(macClaim);
  const macActualBuf = Buffer.from(macActual);
  if (macClaimBuf.length !== macActualBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(macClaimBuf, macActualBuf)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: PendingSignupPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encoded).toString()
    ) as PendingSignupPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.provider !== "string" ||
    typeof payload.redirect !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.expiresAt <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

export function buildPendingSignupSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodedValue}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

export function buildPendingSignupClearCookie(): string {
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=0`;
}

export function readPendingSignupCookie(headers: Headers): string | null {
  const cookie = headers.get("cookie");
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return null;
}
