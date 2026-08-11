// In-memory per pod. In a multi-replica deployment, each pod tracks its own
// window. Effective limit is LIMIT * num_replicas. Replace with Redis-backed
// solution when replica count grows.
//
// AI generation is expensive (per-token billing on OpenAI/Anthropic), so the
// limit is tighter than the execute endpoint (60/min) and MCP (120/min).

const WINDOW_MS = 60_000;
const LIMIT = 10;

const requestLog = new Map<string, number[]>();

export type AiRateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

export function checkAiGenerateRateLimit(key: string): AiRateLimitResult {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  const timestamps = requestLog.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= LIMIT) {
    const oldestInWindow = recent[0];
    const retryAfter = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return {
      allowed: false,
      retryAfter: Math.max(retryAfter, 1),
      limit: LIMIT,
      remaining: 0,
      reset: Math.ceil((oldestInWindow + WINDOW_MS) / 1000),
    };
  }

  recent.push(now);
  requestLog.set(key, recent);

  const reset = Math.ceil((recent[0] + WINDOW_MS) / 1000);
  return {
    allowed: true,
    limit: LIMIT,
    remaining: LIMIT - recent.length,
    reset,
  };
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
  requestLog.clear();
}
