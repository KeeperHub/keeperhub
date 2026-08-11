import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed cookie that bridges the OAuth callback to the /verify-mfa
 * step for TOTP-enrolled users. After Better Auth finishes the OAuth
 * code exchange we intentionally throw away the session it minted and
 * issue THIS cookie instead. It carries just enough identity to let
 * /api/auth/oauth-mfa-finalize bind the user back to a real session
 * once both factors verify, but nothing usable on its own: the cookie
 * is only valid as input to the finalize endpoint, which still requires
 * the email-OTP + TOTP pair.
 *
 * Threat model:
 *   - Attacker who lifts the cookie mid-flow cannot replay it without
 *     also producing both codes. The finalize endpoint runs the same
 *     requireDualFactor primitive used by every other sensitive action.
 *   - HMAC under BETTER_AUTH_SECRET prevents forgery. Tamper with the
 *     payload and the MAC check fails.
 *   - Cookie carries its own expiresAt and we re-check on every read,
 *     so even a server-side bug that forgets to clear an expired cookie
 *     cannot extend the bridge window.
 */

const COOKIE_NAME = "pending_oauth_mfa";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type PendingOauthMfaPayload = {
  userId: string;
  email: string;
  redirect: string;
  expiresAt: number;
};

export type PendingOauthMfaCookieName = typeof COOKIE_NAME;

export function pendingOauthMfaCookieName(): PendingOauthMfaCookieName {
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

/**
 * Encode + sign a pending-oauth-MFA payload. Returns the value to put
 * in the cookie. The cookie itself should be set HttpOnly, SameSite
 * Lax, Secure in production, and Max-Age matching `ttlMs`.
 */
export function encodePendingOauthMfaCookie(
  payload: Omit<PendingOauthMfaPayload, "expiresAt">,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const full: PendingOauthMfaPayload = {
    ...payload,
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

export type DecodeResult =
  | { ok: true; payload: PendingOauthMfaPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Decode + verify a cookie value. Returns the payload only if the
 * HMAC matches and the embedded expiresAt is in the future. Constant-
 * time MAC compare to avoid timing leaks.
 */
export function decodePendingOauthMfaCookie(
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
  let payload: PendingOauthMfaPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encoded).toString()
    ) as PendingOauthMfaPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.email !== "string" ||
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

/**
 * Build the Set-Cookie header value for the pending cookie. Keep
 * settings tight: HttpOnly so JS can't read it, SameSite=Lax so it
 * survives the OAuth top-level redirect back to us, Secure in
 * production. Max-Age matches the TTL embedded in the payload.
 */
export function buildPendingOauthMfaSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodedValue}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * Build the Set-Cookie header value that clears the pending cookie.
 * Used after the user finishes MFA finalize, or after explicit cancel.
 */
export function buildPendingOauthMfaClearCookie(): string {
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=0`;
}

/**
 * Parse the pending cookie out of an incoming request's Cookie header.
 * Returns null when absent so callers can branch cleanly.
 */
export function readPendingOauthMfaCookie(headers: Headers): string | null {
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
