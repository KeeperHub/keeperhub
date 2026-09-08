import { afterEach, describe, expect, it, vi } from "vitest";

// The MCP limiter prefers Redis; pin it to absent so this file asserts the
// shared result metadata rather than the store behind it.
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

import {
  __resetAiGenerateRateLimitForTests,
  checkAiGenerateRateLimit,
} from "@/app/api/ai/_lib/rate-limit";
import { checkRateLimit } from "@/app/api/execute/_lib/rate-limit";
import {
  __resetInviteFetchRateLimitForTests,
  checkInviteFetchRateLimit,
} from "@/app/api/invitations/_lib/rate-limit";
import {
  checkIpRateLimit,
  checkMcpRateLimit,
  LIMIT as MCP_LIMIT,
  resetRateLimitState,
} from "@/lib/mcp/rate-limit";
import { checkVoteRateLimit } from "@/lib/workflow/editor/vote-rate-limit";

const EXECUTE_LIMIT = 60;

afterEach(() => {
  resetRateLimitState();
  __resetAiGenerateRateLimitForTests();
  __resetInviteFetchRateLimitForTests();
});

describe("checkRateLimit (execute)", () => {
  it("reports limit/remaining/reset on the first allowed request", () => {
    const result = checkRateLimit("execute-meta-key-1");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.limit).toBe(EXECUTE_LIMIT);
      expect(result.remaining).toBe(EXECUTE_LIMIT - 1);
      expect(result.reset).toBeGreaterThan(0);
    }
  });

  it("decrements remaining as the window fills, then denies with remaining 0", () => {
    const key = "execute-meta-key-2";
    let last = checkRateLimit(key);
    for (let i = 1; i < EXECUTE_LIMIT; i++) {
      last = checkRateLimit(key);
    }
    expect(last.allowed).toBe(true);
    if (last.allowed) {
      expect(last.remaining).toBe(0);
    }

    const denied = checkRateLimit(key);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.remaining).toBe(0);
      expect(denied.limit).toBe(EXECUTE_LIMIT);
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
      expect(denied.reset).toBeGreaterThan(0);
    }
  });
});

describe("checkMcpRateLimit", () => {
  it("reports the MCP limit and remaining on an allowed request", async () => {
    const result = await checkMcpRateLimit("org-meta-1");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.limit).toBe(MCP_LIMIT);
      expect(result.remaining).toBe(MCP_LIMIT - 1);
    }
  });
});

// checkIpRateLimit shares its window bookkeeping with the MCP limiter and
// backs seven other routes (OAuth token/register, the public MCP surface, the
// marketplace workflow routes, execution-status polling). These pin the full
// result shape on both branches so the shared helper cannot drift underneath
// callers this file does not exercise.
describe("checkIpRateLimit", () => {
  it("honours the caller-supplied limit in the metadata", () => {
    const before = Math.floor(Date.now() / 1000);
    const allowed = checkIpRateLimit("ip-meta-1", 3, 60_000);
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) {
      expect(allowed.limit).toBe(3);
      expect(allowed.remaining).toBe(2);
      expect(allowed.reset).toBeGreaterThanOrEqual(before + 60);
      expect(allowed.reset).toBeLessThanOrEqual(before + 61);
    }
  });

  it("denies once the limit is reached with remaining 0 and a Retry-After", () => {
    const key = "ip-meta-2";
    const before = Math.floor(Date.now() / 1000);
    checkIpRateLimit(key, 2, 60_000);
    checkIpRateLimit(key, 2, 60_000);
    const denied = checkIpRateLimit(key, 2, 60_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.limit).toBe(2);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfter).toBeLessThanOrEqual(60);
      // The oldest request in the window is what frees the next slot, so the
      // denial points at that entry's expiry, not at a fresh window.
      expect(denied.reset).toBeGreaterThanOrEqual(before + 60);
      expect(denied.reset).toBeLessThanOrEqual(before + 61);
    }
  });

  it("keeps counting a key across denials instead of forgetting it", () => {
    const key = "ip-meta-3";
    checkIpRateLimit(key, 1, 60_000);
    expect(checkIpRateLimit(key, 1, 60_000).allowed).toBe(false);
    expect(checkIpRateLimit(key, 1, 60_000).allowed).toBe(false);
  });
});

describe("checkAiGenerateRateLimit", () => {
  it("reports limit/remaining/reset on an allowed request", () => {
    const result = checkAiGenerateRateLimit("ai-meta-1");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(result.reset).toBeGreaterThan(0);
    }
  });
});

describe("checkInviteFetchRateLimit", () => {
  it("reports limit/remaining on an allowed request", () => {
    const result = checkInviteFetchRateLimit("invite-meta-1");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.limit).toBe(60);
      expect(result.remaining).toBe(59);
    }
  });
});

describe("checkVoteRateLimit", () => {
  it("reports metadata and denies with remaining 0 past the limit", () => {
    const key = "vote-meta-1";
    const first = checkVoteRateLimit(key);
    expect(first.allowed).toBe(true);
    if (first.allowed) {
      expect(first.limit).toBe(20);
      expect(first.remaining).toBe(19);
    }

    for (let i = first.remaining; i > 0; i--) {
      checkVoteRateLimit(key);
    }
    const denied = checkVoteRateLimit(key);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });
});
