/**
 * Acceptance test for running on a domain KeeperHub does not own.
 *
 * Before ADDITIONAL_TRUSTED_ORIGINS existed, a deployment on a client's own
 * host loaded and signed in fine and then failed every write with 403 and
 * `[csrf] blocked: untrusted origin`, because the trusted-origin list was fixed
 * at build time. This drives the real proxy - the same gate that rejected those
 * writes - with a foreign Origin header and asserts the mutating request now
 * completes.
 *
 * Pairs with `tests/unit/trusted-origins.test.ts`, which covers the parser and
 * the patterns it refuses. This one covers the request path end to end.
 *
 * The list is built once at module load, so each case sets the environment and
 * then re-imports both the seam and the proxy.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSession,
  mockGateCountry,
  mockResolveDevice,
  mockReadDeviceCookie,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGateCountry: vi.fn(),
  mockResolveDevice: vi.fn(),
  mockReadDeviceCookie: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));
vi.mock("@/lib/security/login-risk", () => ({
  gateRequestCountry: mockGateCountry,
}));
vi.mock("@/lib/security/device-trust", () => ({
  resolveSigninDevice: mockResolveDevice,
}));
vi.mock("@/lib/device-cookie", () => ({
  readDeviceCookie: mockReadDeviceCookie,
}));

const CLIENT_HOST = "https://keeperhub.acme.example";
const SESSION_COOKIE = "better-auth.session_token=abc";

const originalEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(null);
  mockGateCountry.mockReset();
  mockGateCountry.mockResolvedValue({ kind: "no_country" });
  mockResolveDevice.mockReset();
  mockResolveDevice.mockResolvedValue(null);
  mockReadDeviceCookie.mockReset();
  mockReadDeviceCookie.mockReturnValue(null);
});

afterEach(() => {
  process.env = originalEnv;
});

/**
 * Loads the proxy with ADDITIONAL_TRUSTED_ORIGINS set to `value`, or genuinely
 * absent when undefined. The key is rebuilt out of the environment rather than
 * assigned undefined, which would store the string "undefined" and be parsed as
 * a configured value.
 */
async function proxyWith(
  value: string | undefined
): Promise<typeof import("@/proxy")["proxy"]> {
  const { ADDITIONAL_TRUSTED_ORIGINS: _omitted, ...rest } = originalEnv;
  process.env =
    value === undefined
      ? (rest as NodeJS.ProcessEnv)
      : { ...rest, ADDITIONAL_TRUSTED_ORIGINS: value };
  const mod = await import("@/proxy");
  return mod.proxy;
}

function write(origin: string): NextRequest {
  return new NextRequest(new URL("/api/workflows", "http://localhost:3000"), {
    method: "POST",
    headers: new Headers({ cookie: SESSION_COOKIE, origin }),
  });
}

describe("a deployment served on a domain we do not own", () => {
  // The acceptance criterion for KEEP-1110: sign in, then complete a mutating
  // API call on an arbitrary domain.
  it("completes a cookie-authenticated write from its own origin", async () => {
    const proxy = await proxyWith(CLIENT_HOST);
    const res = await proxy(write(CLIENT_HOST));
    expect(res.status).toBe(200);
  });

  // The regression this guards. Without the seam the same request is refused,
  // which is exactly what a client saw when saving a workflow.
  it("is refused when the origin is not configured", async () => {
    const proxy = await proxyWith(undefined);
    const res = await proxy(write(CLIENT_HOST));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Invalid origin" });
  });

  // Widening the list for one host must not widen it for every host.
  it("still refuses an origin nobody configured", async () => {
    const proxy = await proxyWith(CLIENT_HOST);
    const res = await proxy(write("https://evil.example.com"));
    expect(res.status).toBe(403);
  });

  it("accepts a wildcard subdomain of the configured host", async () => {
    const proxy = await proxyWith("https://*.acme.internal");
    await expect(
      proxy(write("https://keeperhub.acme.internal"))
    ).resolves.toMatchObject({ status: 200 });
    // The bare suffix is a different host and stays untrusted.
    await expect(proxy(write("https://acme.internal"))).resolves.toMatchObject({
      status: 403,
    });
  });

  // An unsafe pattern is dropped by the parser rather than honoured, so a
  // configuration mistake cannot silently trust the whole internet.
  it("does not trust everything when given a bare wildcard", async () => {
    const proxy = await proxyWith("https://*");
    const res = await proxy(write("https://evil.example.com"));
    expect(res.status).toBe(403);
  });

  // KeeperHub's own deployments must be unaffected by the seam existing.
  it("keeps the built-in origins working when extra ones are configured", async () => {
    const proxy = await proxyWith(CLIENT_HOST);
    await expect(
      proxy(write("https://app.keeperhub.com"))
    ).resolves.toMatchObject({ status: 200 });
  });
});
