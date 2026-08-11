import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Long-lived signed cookie that gives a browser a stable device identity
 * across IP and country changes. Minted on the first trusted sign-in and
 * refreshed on every subsequent one. Its id is matched against
 * user_trusted_devices: a sign-in whose device id is absent from that
 * list (and is not the account's first device) triggers a courtesy
 * new-device warning email.
 *
 * The cookie is not an authenticator -- it carries no session power. It
 * exists only so a returning browser is recognised and not re-emailed.
 * HMAC-SHA256 under BETTER_AUTH_SECRET keeps the id from being tampered
 * with; a cleared or forged cookie simply reads as a new device.
 */

const COOKIE_NAME = "kh_device_id";
const DEFAULT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type DeviceCookiePayload = {
  deviceId: string;
};

export function deviceCookieName(): string {
  return COOKIE_NAME;
}

export function newDeviceId(): string {
  return randomUUID();
}

const PLUS_RE = /\+/g;
const SLASH_RE = /\//g;
const TRAILING_EQ_RE = /=+$/;
const DASH_RE = /-/g;
const UNDERSCORE_RE = /_/g;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(PLUS_RE, "-")
    .replace(SLASH_RE, "_")
    .replace(TRAILING_EQ_RE, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(DASH_RE, "+").replace(UNDERSCORE_RE, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

export function encodeDeviceCookie(deviceId: string, secret: string): string {
  const encoded = base64UrlEncode(JSON.stringify({ deviceId }));
  const mac = sign(encoded, secret);
  return `${encoded}.${mac}`;
}

export type DecodeDeviceResult =
  | { ok: true; payload: DeviceCookiePayload }
  | { ok: false };

export function decodeDeviceCookie(
  cookieValue: string,
  secret: string
): DecodeDeviceResult {
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) {
    return { ok: false };
  }
  const encoded = cookieValue.slice(0, dot);
  const macClaim = cookieValue.slice(dot + 1);
  const macActual = sign(encoded, secret);
  const macClaimBuf = Buffer.from(macClaim);
  const macActualBuf = Buffer.from(macActual);
  if (macClaimBuf.length !== macActualBuf.length) {
    return { ok: false };
  }
  if (!timingSafeEqual(macClaimBuf, macActualBuf)) {
    return { ok: false };
  }
  let payload: DeviceCookiePayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encoded).toString()
    ) as DeviceCookiePayload;
  } catch {
    return { ok: false };
  }
  if (typeof payload.deviceId !== "string" || payload.deviceId.length === 0) {
    return { ok: false };
  }
  return { ok: true, payload };
}

export function buildDeviceSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  const maxAge = Math.floor(ttlMs / 1000);
  const secureSegment = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=${encodedValue}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
}

export function readDeviceCookie(headers: Headers): string | null {
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
