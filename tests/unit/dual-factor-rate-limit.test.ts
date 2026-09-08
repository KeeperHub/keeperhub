import { afterEach, describe, expect, it } from "vitest";
import {
  checkDualFactorRateLimit,
  resetDualFactor,
  resetDualFactorRateLimitState,
} from "@/lib/mfa/dual-factor-rate-limit";

describe("dual-factor rate limit", () => {
  afterEach(() => {
    resetDualFactorRateLimitState();
  });

  it("allows the first attempts and blocks after the limit", () => {
    const userId = "user_1";
    const action = "wallet_withdraw";
    for (const _ of Array.from({ length: 10 })) {
      const result = checkDualFactorRateLimit(userId, action);
      expect(result.allowed).toBe(true);
    }
    const blocked = checkDualFactorRateLimit(userId, action);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfter).toBeGreaterThan(0);
    }
  });

  it("tracks each (user, action) independently", () => {
    const userId = "user_1";
    for (const _ of Array.from({ length: 10 })) {
      checkDualFactorRateLimit(userId, "wallet_withdraw");
    }
    const blocked = checkDualFactorRateLimit(userId, "wallet_withdraw");
    expect(blocked.allowed).toBe(false);
    const otherAction = checkDualFactorRateLimit(userId, "export_key");
    expect(otherAction.allowed).toBe(true);
  });

  it("clears the counter on resetDualFactor", () => {
    const userId = "user_1";
    const action = "wallet_withdraw";
    for (const _ of Array.from({ length: 10 })) {
      checkDualFactorRateLimit(userId, action);
    }
    expect(checkDualFactorRateLimit(userId, action).allowed).toBe(false);

    resetDualFactor(userId, action);

    expect(checkDualFactorRateLimit(userId, action).allowed).toBe(true);
  });
});
