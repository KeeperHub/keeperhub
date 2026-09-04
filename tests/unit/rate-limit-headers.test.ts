import { describe, expect, it } from "vitest";
import { dualFactorErrorResponse } from "@/lib/mfa/dual-factor";
import {
  applyRateLimitHeaders,
  rateLimitHeaders,
} from "@/lib/rate-limit-headers";

describe("rateLimitHeaders", () => {
  it("emits both the RFC-draft and legacy spellings on an allowed result", () => {
    // reset is an absolute epoch second; the draft header reports the delta.
    const reset = Math.floor(Date.now() / 1000) + 42;
    const headers = rateLimitHeaders({ limit: 60, remaining: 59, reset });
    expect(headers).toEqual({
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "59",
      "RateLimit-Reset": "42",
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "59",
      "X-RateLimit-Reset": String(reset),
    });
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("keeps X-RateLimit-Reset an absolute epoch second", () => {
    // The kh CLI and existing integrations parse this as a timestamp. Changing
    // its units to match the draft would silently break their backoff maths.
    const headers = rateLimitHeaders({ limit: 60, remaining: 59, reset: 1000 });
    expect(headers["X-RateLimit-Reset"]).toBe("1000");
  });

  it("floors an already-elapsed window at zero rather than reporting negative seconds", () => {
    const headers = rateLimitHeaders({ limit: 60, remaining: 60, reset: 1000 });
    expect(headers["RateLimit-Reset"]).toBe("0");
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
    expect(response.headers.get("RateLimit-Limit")).toBe("60");
    expect(response.headers.get("RateLimit-Remaining")).toBe("12");
    expect(response.headers.get("RateLimit-Reset")).not.toBeNull();
  });

  it("carries both spellings through the immutable-headers rebuild path", () => {
    // Redirects have immutable headers; the helper rebuilds the response.
    const redirect = Response.redirect("https://example.test/", 302);
    const result = applyRateLimitHeaders(redirect, {
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 5,
      retryAfter: 5,
    });
    expect(result.headers.get("RateLimit-Limit")).toBe("10");
    expect(result.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(result.headers.get("Retry-After")).toBe("5");
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
