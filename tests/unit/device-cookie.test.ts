import { describe, expect, it } from "vitest";
import {
  buildDeviceSetCookie,
  decodeDeviceCookie,
  deviceCookieName,
  encodeDeviceCookie,
  newDeviceId,
  readDeviceCookie,
} from "@/lib/device-cookie";

const SECRET = "test-secret-please-ignore";

describe("device cookie round-trip", () => {
  it("encodes and decodes the device id", () => {
    const deviceId = newDeviceId();
    const cookie = encodeDeviceCookie(deviceId, SECRET);
    const decoded = decodeDeviceCookie(cookie, SECRET);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.payload.deviceId).toBe(deviceId);
    }
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = encodeDeviceCookie(newDeviceId(), SECRET);
    expect(decodeDeviceCookie(cookie, "other-secret").ok).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const cookie = encodeDeviceCookie("device-1", SECRET);
    const [, mac] = cookie.split(".");
    const forged = `${Buffer.from(JSON.stringify({ deviceId: "device-2" })).toString("base64url")}.${mac}`;
    expect(decodeDeviceCookie(forged, SECRET).ok).toBe(false);
  });

  it("rejects a malformed cookie", () => {
    expect(decodeDeviceCookie("not-a-cookie", SECRET).ok).toBe(false);
    expect(decodeDeviceCookie("", SECRET).ok).toBe(false);
  });

  it("mints unique device ids", () => {
    expect(newDeviceId()).not.toBe(newDeviceId());
  });
});

describe("device cookie header helpers", () => {
  it("reads the cookie value out of a Cookie header", () => {
    const value = encodeDeviceCookie("device-1", SECRET);
    const headers = new Headers({
      cookie: `other=1; ${deviceCookieName()}=${value}; another=2`,
    });
    expect(readDeviceCookie(headers)).toBe(value);
  });

  it("returns null when the cookie is absent", () => {
    expect(readDeviceCookie(new Headers())).toBeNull();
    expect(readDeviceCookie(new Headers({ cookie: "other=1" }))).toBeNull();
  });

  it("builds an HttpOnly Set-Cookie with the configured name", () => {
    const setCookie = buildDeviceSetCookie("abc");
    expect(setCookie).toContain(`${deviceCookieName()}=abc`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=");
  });
});
