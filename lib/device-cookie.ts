import { randomUUID } from "node:crypto";
import { createSignedCookieCodec } from "@/lib/signed-cookie";

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

const codec = createSignedCookieCodec<DeviceCookiePayload>({
  cookieName: COOKIE_NAME,
  defaultTtlMs: DEFAULT_TTL_MS,
  validatePayload: (payload) =>
    typeof payload.deviceId === "string" && payload.deviceId.length > 0,
  embedExpiry: false,
});

export function deviceCookieName(): string {
  return COOKIE_NAME;
}

export function newDeviceId(): string {
  return randomUUID();
}

export function encodeDeviceCookie(deviceId: string, secret: string): string {
  return codec.encode({ deviceId }, secret);
}

export type DecodeDeviceResult =
  | { ok: true; payload: DeviceCookiePayload }
  | { ok: false };

export function decodeDeviceCookie(
  cookieValue: string,
  secret: string
): DecodeDeviceResult {
  const result = codec.decode(cookieValue, secret);
  if (!result.ok) {
    return { ok: false };
  }
  return result;
}

export function buildDeviceSetCookie(
  encodedValue: string,
  ttlMs: number = DEFAULT_TTL_MS
): string {
  return codec.buildSetCookie(encodedValue, ttlMs);
}

export function readDeviceCookie(headers: Headers): string | null {
  return codec.read(headers);
}
