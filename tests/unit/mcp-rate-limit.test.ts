import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These cases cover the in-memory bookkeeping (sweep, stats). Pinning Redis to
// absent keeps them on the fallback path regardless of the ambient env.
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

import {
  checkIpRateLimit,
  checkMcpRateLimit,
  cleanupExpiredRateLimitEntries,
  getRateLimitStats,
  LIMIT,
  resetRateLimitState,
  stopRateLimitCleanupInterval,
  WINDOW_MS,
} from "@/lib/mcp/rate-limit";

const STALE_AFTER_MS = 5 * WINDOW_MS;

describe("mcp/rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetRateLimitState();
  });

  afterEach(() => {
    stopRateLimitCleanupInterval();
    resetRateLimitState();
    vi.useRealTimers();
  });

  describe("cleanupExpiredRateLimitEntries", () => {
    it("removes organisation entries whose newest timestamp is past the stale threshold", async () => {
      await checkMcpRateLimit("org-a");
      expect(getRateLimitStats().organizationCount).toBe(1);

      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);
      cleanupExpiredRateLimitEntries();

      expect(getRateLimitStats().organizationCount).toBe(0);
    });

    it("removes IP entries whose newest timestamp is past the stale threshold", () => {
      checkIpRateLimit("1.2.3.4", 10, WINDOW_MS);
      expect(getRateLimitStats().ipCount).toBe(1);

      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);
      cleanupExpiredRateLimitEntries();

      expect(getRateLimitStats().ipCount).toBe(0);
    });

    it("preserves entries with activity inside the stale threshold", async () => {
      await checkMcpRateLimit("org-active");
      checkIpRateLimit("9.9.9.9", 10, WINDOW_MS);

      // Half-way through the stale window
      vi.setSystemTime(Date.now() + STALE_AFTER_MS / 2);
      cleanupExpiredRateLimitEntries();

      const stats = getRateLimitStats();
      expect(stats.organizationCount).toBe(1);
      expect(stats.ipCount).toBe(1);
    });

    it("does not break rate-limit decisions when called against an at-limit entry", async () => {
      const allowed = await Promise.all(
        Array.from({ length: LIMIT }, () => checkMcpRateLimit("org-busy"))
      );
      expect(allowed.every((r) => r.allowed)).toBe(true);

      const blocked = await checkMcpRateLimit("org-busy");
      expect(blocked.allowed).toBe(false);

      // Cleanup must NOT drop an entry whose newest timestamp is `now`.
      cleanupExpiredRateLimitEntries();
      expect(getRateLimitStats().organizationCount).toBe(1);

      // And the block must persist.
      const stillBlocked = await checkMcpRateLimit("org-busy");
      expect(stillBlocked.allowed).toBe(false);
    });

    it("self-tunes the stale threshold to the largest IP window seen across callers", () => {
      const TEN_MINUTE_WINDOW_MS = 10 * WINDOW_MS;

      checkIpRateLimit("ip-long-window", 5, TEN_MINUTE_WINDOW_MS);
      expect(getRateLimitStats().ipCount).toBe(1);

      // Past the default 5x60s threshold, but well inside the 10-minute
      // caller's window -- entries must NOT be dropped or the next request
      // would see an empty array and forget the prior burst.
      vi.setSystemTime(Date.now() + 6 * WINDOW_MS);
      cleanupExpiredRateLimitEntries();
      expect(getRateLimitStats().ipCount).toBe(1);

      // Past 5x the largest window (10min * 5 = 50min) -- now safe to drop.
      vi.setSystemTime(Date.now() + 60 * WINDOW_MS);
      cleanupExpiredRateLimitEntries();
      expect(getRateLimitStats().ipCount).toBe(0);
    });

    it("reproduces the leak case: idle keys accumulate without cleanup, are released after cleanup", async () => {
      await checkMcpRateLimit("org-a");
      vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1);

      // Without cleanup: a brand-new key is added and the stale one stays.
      await checkMcpRateLimit("org-b");
      expect(getRateLimitStats().organizationCount).toBe(2);

      // With cleanup: only the recently-active key remains.
      cleanupExpiredRateLimitEntries();
      expect(getRateLimitStats().organizationCount).toBe(1);
    });
  });
});
