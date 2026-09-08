import { createSignedCookieCodec } from "@/lib/signed-cookie";

/**
 * Signed cookie set when a fully-MFA-verified sign-in lands on a new
 * IP. The post-MFA routes (strict-signin, oauth-mfa-finalize) refuse
 * to mint the session in that case and emit this cookie instead;
 * /api/user/verify-ip is the only route that accepts it, alongside
 * a 6-digit email OTP + a TOTP code. No session row exists in
 * between.
 *
 * Threat model:
 *   - Cookie alone does not authenticate. It carries identity but
 *     not the verification proof, which still requires the user to
 *     enter the codes they received and possess.
 *   - HMAC-SHA256 under BETTER_AUTH_SECRET. Constant-time MAC
 *     compare on every read.
 *   - 15-min TTL inside the payload AND on the Set-Cookie Max-Age,
 *     re-checked on every decode.
 *   - `ip` in the payload is the address the user signed in from.
 *     /api/user/verify-ip rejects when the current request IP does
 *     not match, preventing a stolen cookie from being replayed
 *     from another network.
 */

const COOKIE_NAME = "pending_ip_verify";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type PendingIpPayload = {
  userId: string;
  email: string;
  ip: string;
  country: string | null;
  redirect: string;
  expiresAt: number;
};

const codec = createSignedCookieCodec<PendingIpPayload>({
  cookieName: COOKIE_NAME,
  defaultTtlMs: DEFAULT_TTL_MS,
  validatePayload: (payload) =>
    typeof payload.userId === "string" &&
    typeof payload.email === "string" &&
    typeof payload.ip === "string" &&
    typeof payload.redirect === "string" &&
    typeof payload.expiresAt === "number",
  embedExpiry: true,
});

export function pendingIpCookieName(): string {
  return COOKIE_NAME;
}

export function encodePendingIpCookie(
  payload: Omit<PendingIpPayload, "expiresAt">,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const full: PendingIpPayload = {
    ...payload,
    expiresAt: Date.now() + ttlMs,
  };
  return codec.encode(full, secret);
}

export type DecodePendingIpResult =
  | { ok: true; payload: PendingIpPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodePendingIpCookie(
  cookieValue: string,
  secret: string
): DecodePendingIpResult {
  return codec.decode(cookieValue, secret);
}

export function buildPendingIpSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  return codec.buildSetCookie(encodedValue, ttlMs);
}

export function buildPendingIpClearCookie(): string {
  return codec.buildClearCookie();
}

export function readPendingIpCookie(headers: Headers): string | null {
  return codec.read(headers);
}
