import { afterEach, describe, expect, it, vi } from "vitest";
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
