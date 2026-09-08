import { createSignedCookieCodec } from "@/lib/signed-cookie";

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

const codec = createSignedCookieCodec<PendingSignupPayload>({
  cookieName: COOKIE_NAME,
  defaultTtlMs: DEFAULT_TTL_MS,
  validatePayload: (payload) =>
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    typeof payload.provider === "string" &&
    typeof payload.redirect === "string" &&
    typeof payload.expiresAt === "number",
  embedExpiry: true,
});

export function pendingSignupCookieName(): string {
  return COOKIE_NAME;
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
  return codec.encode(full, secret);
}

export type DecodeResult =
  | { ok: true; payload: PendingSignupPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodePendingSignupCookie(
  cookieValue: string,
  secret: string
): DecodeResult {
  return codec.decode(cookieValue, secret);
}

export function buildPendingSignupSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  return codec.buildSetCookie(encodedValue, ttlMs);
}

export function buildPendingSignupClearCookie(): string {
  return codec.buildClearCookie();
}

export function readPendingSignupCookie(headers: Headers): string | null {
  return codec.read(headers);
}
