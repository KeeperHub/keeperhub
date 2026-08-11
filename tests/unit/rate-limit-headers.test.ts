import { describe, expect, it } from "vitest";
import { dualFactorErrorResponse } from "@/lib/mfa/dual-factor";
import {
  applyRateLimitHeaders,
  rateLimitHeaders,
} from "@/lib/rate-limit-headers";

describe("rateLimitHeaders", () => {
  it("emits the standard headers on an allowed result", () => {
    const headers = rateLimitHeaders({ limit: 60, remaining: 59, reset: 1000 });
    expect(headers).toEqual({
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "59",
      "X-RateLimit-Reset": "1000",
    });
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("adds Retry-After only when present", () => {
    const headers = rateLimitHeaders({
      limit: 60,
      remaining: 0,
      reset: 1000,
      retryAfter: 30,
    });
    expect(headers["Retry-After"]).toBe("30");
  });

  it("adds X-Poll-Interval-Hint when provided, including zero", () => {
    expect(
      rateLimitHeaders(
        { limit: 60, remaining: 5, reset: 1000 },
        {
          pollIntervalHint: 2,
        }
      )["X-Poll-Interval-Hint"]
    ).toBe("2");
    expect(
      rateLimitHeaders(
        { limit: 60, remaining: 5, reset: 1000 },
        {
          pollIntervalHint: 0,
        }
      )["X-Poll-Interval-Hint"]
    ).toBe("0");
  });
});

describe("applyRateLimitHeaders", () => {
  it("sets headers on the response and returns the same instance", () => {
    const response = Response.json({ ok: true });
    const result = applyRateLimitHeaders(response, {
      limit: 60,
      remaining: 12,
      reset: 1700,
    });
    expect(result).toBe(response);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("12");
    expect(response.headers.get("X-RateLimit-Reset")).toBe("1700");
  });

  it("preserves existing headers on the response", () => {
    const response = Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
    applyRateLimitHeaders(response, {
      limit: 60,
      remaining: 0,
      reset: 1,
      retryAfter: 5,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});

describe("dualFactorErrorResponse", () => {
  it("sets Retry-After on the rate-limit 429", async () => {
    const res = dualFactorErrorResponse({
      ok: false,
      status: 429,
      error: "Too many attempts. Wait and try again.",
      code: "rate_limited",
      retryAfter: 42,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({
      error: "Too many attempts. Wait and try again.",
      code: "rate_limited",
    });
  });

  it("does not set Retry-After on non-429 failures", () => {
    const res = dualFactorErrorResponse({
      ok: false,
      status: 401,
      error: "Invalid code",
      code: "mfa_code_invalid",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
