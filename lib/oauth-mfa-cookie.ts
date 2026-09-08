import { createSignedCookieCodec } from "@/lib/signed-cookie";

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

const codec = createSignedCookieCodec<PendingOauthMfaPayload>({
  cookieName: COOKIE_NAME,
  defaultTtlMs: DEFAULT_TTL_MS,
  validatePayload: (payload) =>
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    typeof payload.redirect === "string" &&
    typeof payload.expiresAt === "number",
  embedExpiry: true,
});

export function pendingOauthMfaCookieName(): PendingOauthMfaCookieName {
  return COOKIE_NAME;
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
  return codec.encode(full, secret);
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
  return codec.decode(cookieValue, secret);
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
  return codec.buildSetCookie(encodedValue, ttlMs);
}

/**
 * Build the Set-Cookie header value that clears the pending cookie.
 * Used after the user finishes MFA finalize, or after explicit cancel.
 */
export function buildPendingOauthMfaClearCookie(): string {
  return codec.buildClearCookie();
}

/**
 * Parse the pending cookie out of an incoming request's Cookie header.
 * Returns null when absent so callers can branch cleanly.
 */
export function readPendingOauthMfaCookie(headers: Headers): string | null {
  return codec.read(headers);
}
