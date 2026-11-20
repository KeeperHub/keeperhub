import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "@/lib/rate-limit/sliding-window";

describe("sliding window weight", () => {
  it("takes all of a weighted call's slots, or none of them", () => {
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.check("k", 3)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    // Three more do not fit: refused, and nothing is taken.
    expect(limiter.check("k", 3)).toMatchObject({
      allowed: false,
      remaining: 2,
    });
    expect(limiter.check("k", 2)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check("k")).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("keeps keys apart and counts an unweighted call as one", () => {
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("b", 2)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
  });
});
