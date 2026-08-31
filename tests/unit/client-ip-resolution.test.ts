import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClientIpFromHeaders } from "@/lib/security/login-risk";

function headersOf(values: Record<string, string>): Pick<Headers, "get"> {
  const map = new Map<string, string>(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveClientIpFromHeaders in production", () => {
  it("returns CF-Connecting-IP when present", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      resolveClientIpFromHeaders(
        headersOf({ "cf-connecting-ip": "203.0.113.7" })
      )
    ).toBe("203.0.113.7");
  });

  it("prefers CF-Connecting-IP over a spoofable X-Forwarded-For", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      resolveClientIpFromHeaders(
        headersOf({
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "10.1.2.3",
        })
      )
    ).toBe("203.0.113.7");
  });

  it("ignores an internal node IP carried in X-Forwarded-For and returns null", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      resolveClientIpFromHeaders(headersOf({ "x-forwarded-for": "10.1.2.3" }))
    ).toBeNull();
  });

  it("ignores X-Real-IP and returns null when CF-Connecting-IP is absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(
      resolveClientIpFromHeaders(headersOf({ "x-real-ip": "10.1.2.4" }))
    ).toBeNull();
  });

  it("returns null when no header is present", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveClientIpFromHeaders(headersOf({}))).toBeNull();
  });
});

describe("resolveClientIpFromHeaders outside production", () => {
  it("still prefers CF-Connecting-IP", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      resolveClientIpFromHeaders(
        headersOf({
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.4",
        })
      )
    ).toBe("203.0.113.7");
  });

  it("falls back to the first X-Forwarded-For hop, trimmed", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      resolveClientIpFromHeaders(
        headersOf({ "x-forwarded-for": " 198.51.100.4 , 10.0.0.1 " })
      )
    ).toBe("198.51.100.4");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      resolveClientIpFromHeaders(headersOf({ "x-real-ip": "198.51.100.4" }))
    ).toBe("198.51.100.4");
  });

  it("returns null when no header is present", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveClientIpFromHeaders(headersOf({}))).toBeNull();
  });
});

/**
 * The header list is built once at module load, so these cases re-import both the
 * seam and login-risk after changing the environment. The suites above stay on
 * vi.stubEnv because NODE_ENV is read per call.
 */
describe("resolveClientIpFromHeaders with CLIENT_IP_HEADERS set", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllEnvs();
  });

  async function loadWith(
    value: string | undefined
  ): Promise<typeof import("@/lib/security/login-risk")> {
    // Rebuilt without the key so the unset case really is absent; assigning
    // undefined would store the literal string "undefined".
    const { CLIENT_IP_HEADERS: _omitted, ...rest } = originalEnv;
    process.env =
      value === undefined
        ? ({ ...rest, NODE_ENV: "production" } as NodeJS.ProcessEnv)
        : { ...rest, NODE_ENV: "production", CLIENT_IP_HEADERS: value };
    return await import("@/lib/security/login-risk");
  }

  // The defect this seam exists for: in production, with no Cloudflare in front,
  // nothing resolved and every session recorded no address.
  it("unset still resolves nothing but CF-Connecting-IP in production", async () => {
    const { resolveClientIpFromHeaders: resolve } = await loadWith(undefined);
    expect(resolve(headersOf({ "x-real-ip": "198.51.100.4" }))).toBeNull();
    expect(resolve(headersOf({ "cf-connecting-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7"
    );
  });

  it("resolves the configured header in production", async () => {
    const { resolveClientIpFromHeaders: resolve } = await loadWith("X-Real-IP");
    expect(resolve(headersOf({ "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
  });

  it("stops trusting CF-Connecting-IP once another header is named", async () => {
    const { resolveClientIpFromHeaders: resolve } = await loadWith("X-Real-IP");
    expect(
      resolve(headersOf({ "cf-connecting-ip": "203.0.113.7" }))
    ).toBeNull();
  });

  it("tries several configured headers in order", async () => {
    const { resolveClientIpFromHeaders: resolve } = await loadWith(
      "X-Real-IP,CF-Connecting-IP"
    );
    expect(
      resolve(
        headersOf({
          "cf-connecting-ip": "203.0.113.7",
          "x-real-ip": "198.51.100.4",
        })
      )
    ).toBe("198.51.100.4");
    expect(resolve(headersOf({ "cf-connecting-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7"
    );
  });

  it("returns null in production when the configured header is absent", async () => {
    const { resolveClientIpFromHeaders: resolve } = await loadWith("X-Real-IP");
    expect(resolve(headersOf({ "x-forwarded-for": "10.1.2.3" }))).toBeNull();
  });

  it("keeps the non-production fallback when the configured header is absent", async () => {
    const { CLIENT_IP_HEADERS: _omitted, ...rest } = originalEnv;
    process.env = {
      ...rest,
      NODE_ENV: "development",
      CLIENT_IP_HEADERS: "X-Real-IP",
    };
    const { resolveClientIpFromHeaders: resolve } = await import(
      "@/lib/security/login-risk"
    );
    expect(resolve(headersOf({ "x-forwarded-for": "198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
  });
});
