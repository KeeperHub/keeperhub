// In-memory per pod. In a multi-replica deployment, each pod tracks its own
// window. Effective limit is LIMIT * num_replicas. Replace with Redis-backed
// solution when replica count grows.
//
// This endpoint is unauthenticated (the invite ID is a high-entropy bearer
// token), so the only available rate-limit key is the client IP. The limit is
// generous because a legitimate caller opening the manage-orgs modal fetches
// one entry per pending invitation in parallel.

import {
  createSlidingWindowLimiter,
  type SlidingWindowRateLimitResult,
} from "@/lib/rate-limit/sliding-window";
import { getRequestSourceIp } from "@/lib/security/request-attribution";

const WINDOW_MS = 60_000;
const LIMIT = 60;

export type InviteRateLimitResult = SlidingWindowRateLimitResult;

const limiter = createSlidingWindowLimiter({
  limit: LIMIT,
  windowMs: WINDOW_MS,
});

export function checkInviteFetchRateLimit(key: string): InviteRateLimitResult {
  return limiter.check(key);
}

// Derives the rate-limit bucket from the trusted client IP (Cloudflare
// `cf-connecting-ip` first, then trusted-proxy XFF resolution). Reading the
// raw `x-forwarded-for` header would let any caller spoof a new IP per
// request and burn through the limit -- see lib/security/request-attribution.
// Falls back to a shared "unknown" bucket when no trustworthy source is
// present so the limiter still applies (conservatively) rather than failing
// open per-request.
export function getInviteFetchRateLimitKey(request: Request): string {
  const ip = getRequestSourceIp(request);
  return ip ? `ip:${ip}` : "ip:unknown";
}

// Test-only reset hook. Production code never imports this.
export function __resetInviteFetchRateLimitForTests(): void {
  limiter.__reset();
}
