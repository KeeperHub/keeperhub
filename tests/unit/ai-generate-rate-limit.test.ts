import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAiGenerateRateLimitForTests,
  checkAiGenerateRateLimit,
  getAiGenerateRateLimitKey,
} from "@/app/api/ai/_lib/rate-limit";

describe("getAiGenerateRateLimitKey", () => {
  it("prefers apiKeyId", () => {
    expect(
      getAiGenerateRateLimitKey({
        apiKeyId: "ak_1",
        userId: "u_1",
        organizationId: "o_1",
      })
    ).toBe("apikey:ak_1");
  });

  it("falls back to userId when no apiKeyId", () => {
    expect(
      getAiGenerateRateLimitKey({
        apiKeyId: null,
        userId: "u_1",
        organizationId: "o_1",
      })
    ).toBe("user:u_1");
  });

  it("falls back to organizationId last", () => {
    expect(
      getAiGenerateRateLimitKey({
        apiKeyId: null,
        userId: null,
        organizationId: "o_1",
      })
    ).toBe("org:o_1");
  });

  it("returns 'unknown' if all identifiers are null", () => {
    expect(
      getAiGenerateRateLimitKey({
        apiKeyId: null,
        userId: null,
        organizationId: null,
      })
    ).toBe("unknown");
  });
});

describe("checkAiGenerateRateLimit", () => {
  beforeEach(() => {
    __resetAiGenerateRateLimitForTests();
  });

  it("allows requests up to the per-window limit", () => {
    for (let i = 0; i < 10; i += 1) {
      const result = checkAiGenerateRateLimit("user:test");
      expect(result.allowed).toBe(true);
    }
  });

  it("rejects the 11th request within the window", () => {
    for (let i = 0; i < 10; i += 1) {
      checkAiGenerateRateLimit("user:test");
    }
    const result = checkAiGenerateRateLimit("user:test");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThanOrEqual(1);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("isolates buckets by key", () => {
    for (let i = 0; i < 10; i += 1) {
      checkAiGenerateRateLimit("user:a");
    }
    expect(checkAiGenerateRateLimit("user:a").allowed).toBe(false);
    expect(checkAiGenerateRateLimit("user:b").allowed).toBe(true);
  });
});
