import "server-only";

import { createSlidingWindowLimiter } from "@/lib/rate-limit/sliding-window";
import { getRedis } from "@/lib/redis";
import {
  TESTS_PER_DAY_PER_ORG,
  TESTS_PER_MINUTE_PER_USER,
  VERIFY_CHECKS_PER_MINUTE_PER_ORG,
} from "./constants";

/** Test limits by scope, for Redis and for the per-pod fallback alike. */
const TEST_LIMITS = {
  user: {
    limit: TESTS_PER_MINUTE_PER_USER,
    windowMs: 60 * 1000,
    keyPrefix: "failure-alert-test:user:",
  },
  org: {
    limit: TESTS_PER_DAY_PER_ORG,
    windowMs: 24 * 60 * 60 * 1000,
    keyPrefix: "failure-alert-test:org:",
  },
  // Silent checks a settings save runs on new methods, per org.
  verify: {
    limit: VERIFY_CHECKS_PER_MINUTE_PER_ORG,
    windowMs: 60 * 1000,
    keyPrefix: "failure-alert-verify:org:",
  },
} as const;
export type TestScope = keyof typeof TEST_LIMITS;

/** Per-pod windows for a deployment without Redis: looser, never open. */
const localWindows: Record<
  TestScope,
  ReturnType<typeof createSlidingWindowLimiter>
> = {
  user: createSlidingWindowLimiter(TEST_LIMITS.user),
  org: createSlidingWindowLimiter(TEST_LIMITS.org),
  verify: createSlidingWindowLimiter(TEST_LIMITS.verify),
};

/** Takes `weight` slots, or none when they do not all fit; `left` is what remains. */
export async function takeSlots(
  scope: TestScope,
  id: string,
  weight = 1
): Promise<{ ok: boolean; left: number }> {
  const { limit, windowMs, keyPrefix } = TEST_LIMITS[scope];
  const key = `${keyPrefix}${id}`;
  const redis = getRedis();
  if (redis) {
    try {
      const count = await redis.incrby(key, weight);
      // Checked on every call, so a key whose expiry failed to set once heals itself.
      if ((await redis.ttl(key)) < 0) {
        await redis.expire(key, windowMs / 1000);
      }
      if (count > limit) {
        await redis.decrby(key, weight);
        return { ok: false, left: Math.max(0, limit - (count - weight)) };
      }
      return { ok: true, left: limit - count };
    } catch {
      // Fall through to the in-memory window.
    }
  }
  const local = localWindows[scope].check(key, weight);
  return { ok: local.allowed, left: local.remaining };
}
