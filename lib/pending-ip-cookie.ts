import { createHmac, timingSafeEqual } from "node:crypto";

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

export function pendingIpCookieName(): string {
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

export function encodePendingIpCookie(
  payload: Omit<PendingIpPayload, "expiresAt">,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const full: PendingIpPayload = {
    ...payload,
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = base64UrlEncode(JSON.stringify(full));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

export type DecodePendingIpResult =
  | { ok: true; payload: PendingIpPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function decodePendingIpCookie(
  cookieValue: string,
  secret: string
): DecodePendingIpResult {
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
  let payload: PendingIpPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encoded).toString()
    ) as PendingIpPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.ip !== "string" ||
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

export function buildPendingIpSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodedValue}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

export function buildPendingIpClearCookie(): string {
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=0`;
}

export function readPendingIpCookie(headers: Headers): string | null {
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
