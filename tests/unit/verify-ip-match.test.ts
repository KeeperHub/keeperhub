import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isVerifyIpMatch } from "@/app/api/user/verify-ip/_lib/ip-match";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isVerifyIpMatch (F-016 / KEEP-741 fail-closed)", () => {
  it("matches when the current IP is in the same /24 network as the cookie IP", () => {
    expect(isVerifyIpMatch("203.0.113.7", "203.0.113.250")).toBe(true);
  });

  it("rejects when the current IP is a different network", () => {
    expect(isVerifyIpMatch("198.51.100.7", "203.0.113.7")).toBe(false);
  });

  it("FAILS CLOSED in production when the client IP cannot be resolved", () => {
    vi.stubEnv("NODE_ENV", "production");
    // Pre-fix this returned true (the !currentRawIp short-circuit), letting a
    // request that bypassed Cloudflare skip the IP binding entirely.
    expect(isVerifyIpMatch(null, "203.0.113.7")).toBe(false);
  });

  it("still passes outside production when the IP is unresolved (local dev)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isVerifyIpMatch(null, "203.0.113.7")).toBe(true);
  });
});
