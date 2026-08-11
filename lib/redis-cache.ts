import "server-only";

import { getRedis } from "@/lib/redis";

/**
 * Read-through cache over the best-effort app-tier Redis.
 *
 * Inherits the contract from `lib/redis`: Redis is a cross-replica
 * optimisation, never a source of truth. Every failure mode (no client,
 * unreachable, corrupt value, rejected write) degrades to calling `read`, so a
 * caller behaves identically with Redis absent, just with more round-trips.
 *
 * Keys must come from `lib/redis-keys` so namespaces cannot drift.
 */
export async function cachedRead<T>(input: {
  key: string;
  ttlSeconds: number;
  /** Parse a cached string back to `T`. May throw; a throw is treated as a miss. */
  decode: (raw: string) => T;
  encode: (value: T) => string;
  /** Source of truth, called on any miss. */
  read: () => Promise<T>;
}): Promise<T> {
  const { key, ttlSeconds, decode, encode, read } = input;
  const redis = getRedis();

  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit !== null) {
        return decode(hit);
      }
    } catch {
      // Unreachable or unparseable: fall through to the source of truth.
    }
  }

  const value = await read();

  if (redis) {
    try {
      await redis.set(key, encode(value), "EX", ttlSeconds);
    } catch {
      // A cache write failure must not fail the caller.
    }
  }

  return value;
}
