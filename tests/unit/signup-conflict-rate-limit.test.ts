import { beforeEach, describe, expect, it } from "vitest";

import { checkCredentialAttemptRateLimit } from "@/app/api/auth/_lib/credential-attempt-rate-limit";
import {
  __resetSignupConflictRateLimit,
  checkSignupConflictRateLimit,
} from "@/app/api/auth/_lib/signup-conflict-rate-limit";

beforeEach(() => {
  __resetSignupConflictRateLimit();
});

describe("checkSignupConflictRateLimit", () => {
  it("allows the first 5 lookups per email then blocks", () => {
    const email = "victim@example.com";
    for (let i = 0; i < 5; i++) {
      expect(checkSignupConflictRateLimit(email, `10.0.0.${i}`).allowed).toBe(
        true
      );
    }
    const blocked = checkSignupConflictRateLimit(email, "10.0.0.99");
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.scope).toBe("email");
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("blocks per-IP after 15 lookups across different emails", () => {
    const ip = "203.0.113.5";
    for (let i = 0; i < 15; i++) {
      expect(
        checkSignupConflictRateLimit(`user${i}@example.com`, ip).allowed
      ).toBe(true);
    }
    const blocked = checkSignupConflictRateLimit("user99@example.com", ip);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.scope).toBe("ip");
    }
  });

  it("does not share buckets with the credential-password limiter", () => {
    // This endpoint takes no password, so sharing would let anyone lock a known
    // address out of sign-in for the window at zero cost.
    const email = "target@example.com";
    for (let i = 0; i < 5; i++) {
      expect(
        checkSignupConflictRateLimit(email, `198.51.100.${i}`).allowed
      ).toBe(true);
    }
    expect(checkSignupConflictRateLimit(email, "198.51.100.200").allowed).toBe(
      false
    );
    expect(
      checkCredentialAttemptRateLimit(email, "198.51.100.200").allowed
    ).toBe(true);
  });
});
