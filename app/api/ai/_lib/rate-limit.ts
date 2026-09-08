// In-memory per pod. In a multi-replica deployment, each pod tracks its own
// window. Effective limit is LIMIT * num_replicas. Replace with Redis-backed
// solution when replica count grows.
//
// AI generation is expensive (per-token billing on OpenAI/Anthropic), so the
// limit is tighter than the execute endpoint (60/min) and MCP (120/min).

import {
  createSlidingWindowLimiter,
  type SlidingWindowRateLimitResult,
} from "@/lib/rate-limit/sliding-window";

const WINDOW_MS = 60_000;
const LIMIT = 10;

export type AiRateLimitResult = SlidingWindowRateLimitResult;

const limiter = createSlidingWindowLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
});

export function checkAiGenerateRateLimit(key: string): AiRateLimitResult {
  return limiter.check(key);
}

type RateLimitContext = {
  apiKeyId: string | null;
  userId: string | null;
  organizationId: string | null;
};

// Identifies the caller for rate-limiting. API keys are the most stable handle
// (one key per integration), userId covers session/oauth callers, and
// organizationId is the last fallback so a request that authenticated against
// an org but somehow has no userId still gets bucketed.
export function getAiGenerateRateLimitKey(ctx: RateLimitContext): string {
  if (ctx.apiKeyId) {
    return `apikey:${ctx.apiKeyId}`;
  }
  if (ctx.userId) {
    return `user:${ctx.userId}`;
  }
  if (ctx.organizationId) {
    return `org:${ctx.organizationId}`;
  }
  return "unknown";
}

// Test-only reset hook. Production code never imports this.
export function __resetAiGenerateRateLimitForTests(): void {
  limiter.__reset();
}
