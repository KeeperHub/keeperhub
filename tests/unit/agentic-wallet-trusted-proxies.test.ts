import { describe, expect, it } from "vitest";
import { resolveTrustedClientIp } from "@/lib/security/trusted-proxies";

function mockRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/", { headers });
}

describe("resolveTrustedClientIp", () => {
  it("returns the connecting IP when request comes via a trusted proxy", () => {
    const req = mockRequest({
      "x-forwarded-for": "203.0.113.10, 173.245.48.1",
      "x-real-ip": "173.245.48.1",
    });
    // 173.245.48.0/20 is a Cloudflare range
    expect(resolveTrustedClientIp(req, "173.245.48.1")).toBe("203.0.113.10");
  });

  it("ignores spoofed XFF when the connecting IP is NOT a trusted proxy", () => {
    const req = mockRequest({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "8.8.8.8",
    });
    expect(resolveTrustedClientIp(req, "8.8.8.8")).toBe("8.8.8.8");
  });

  it("returns 'unknown' when no IP source is available (test env)", () => {
    const req = mockRequest({});
    expect(resolveTrustedClientIp(req, null)).toBe("unknown");
  });

  it("trims and parses the leftmost XFF entry only", () => {
    const req = mockRequest({
      "x-forwarded-for": "  203.0.113.10  ,  10.0.0.1  ",
    });
    expect(resolveTrustedClientIp(req, "173.245.48.1")).toBe("203.0.113.10");
  });
});

describe("IP parsing strictness", () => {
  it("rejects malformed IPs (treated as not-trusted, falls back to connectingIp)", () => {
    const cases = ["1.2.3", "1.2.3.4.5", "a.b.c.d", "1.2.3.256", "-1.2.3.4"];
    for (const bad of cases) {
      const req = new Request("https://example.com/", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      // bad IP is the connecting peer — not trusted, so XFF ignored, returns peer
      expect(resolveTrustedClientIp(req, bad)).toBe(bad);
    }
  });

  it("treats whitespace-only XFF leftmost as missing (returns connecting IP)", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "   ,1.2.3.4" },
    });
    expect(resolveTrustedClientIp(req, "173.245.48.1")).toBe("173.245.48.1");
  });
});
