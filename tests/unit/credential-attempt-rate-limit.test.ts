import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetCredentialAttemptRateLimit,
  checkCredentialAttemptRateLimit,
} from "@/app/api/auth/_lib/credential-attempt-rate-limit";

beforeEach(() => {
  __resetCredentialAttemptRateLimit();
});

describe("checkCredentialAttemptRateLimit (F-013 / KEEP-738)", () => {
  it("allows the first 5 attempts per email then blocks (password-oracle guard)", () => {
    const email = "victim@example.com";
    for (let i = 0; i < 5; i++) {
      expect(
        checkCredentialAttemptRateLimit(email, `10.0.0.${i}`).allowed
      ).toBe(true);
    }
    const blocked = checkCredentialAttemptRateLimit(email, "10.0.0.99");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.scope).toBe("email");
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("blocks per-IP after 20 attempts across different emails (enumeration spray)", () => {
    const ip = "203.0.113.5";
    for (let i = 0; i < 20; i++) {
      expect(
        checkCredentialAttemptRateLimit(`user${i}@example.com`, ip).allowed
      ).toBe(true);
    }
    const blocked = checkCredentialAttemptRateLimit("user99@example.com", ip);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.scope).toBe("ip");
    }
  });

  it("shares the per-email bucket across both oracle endpoints (no fresh allowance by hopping routes)", () => {
    const email = "target@example.com";
    // Simulate 5 attempts against finish-credential-signup (different IPs to
    // isolate the per-email bucket), then a 6th from strict-signin/start: the
    // shared email bucket must already be exhausted.
    for (let i = 0; i < 5; i++) {
      expect(
        checkCredentialAttemptRateLimit(email, `198.51.100.${i}`).allowed
      ).toBe(true);
    }
    const blocked = checkCredentialAttemptRateLimit(email, "198.51.100.200");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.scope).toBe("email");
    }
  });

  it("keys email and IP buckets independently", () => {
    expect(
      checkCredentialAttemptRateLimit("a@example.com", "1.1.1.1").allowed
    ).toBe(true);
    expect(
      checkCredentialAttemptRateLimit("b@example.com", "2.2.2.2").allowed
    ).toBe(true);
  });
});
