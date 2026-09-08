/**
 * Runs the MCP rate limiter's Lua script against a real Redis.
 *
 * The unit suite drives a JS stand-in for the sorted-set semantics, which
 * pins the wrapper's contract but cannot tell whether the script itself
 * compiles or does what the wrapper assumes. A script that silently fails to
 * EVAL in production would not fail any unit test: the limiter would fall
 * back to its per-pod window forever and the fleet-wide ceiling this control
 * exists to enforce would quietly revert to LIMIT * num_replicas.
 *
 * Gated on a reachable Redis so local runs and CI without one are unaffected:
 *
 *   docker run --rm -p 63790:6379 redis:7-alpine
 *   TEST_REDIS_URL=redis://127.0.0.1:63790 pnpm vitest run \
 *     tests/integration/mcp-rate-limit-lua-script.test.ts
 */

import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MCP_SLIDING_WINDOW_SCRIPT } from "@/lib/mcp/rate-limit";

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
const PROBE_TIMEOUT_MS = 750;

async function connectIfReachable(): Promise<Redis | null> {
  const client = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  // A failed probe must not surface as an unhandled 'error' event.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const redis = await connectIfReachable();
const KEY = "test:mcp-rate-limit-lua";

type ScriptReply = [number, number, number, number];

function evalScript(
  client: Redis,
  key: string,
  windowMs: number,
  limit: number,
  member: string
): Promise<ScriptReply> {
  return client.eval(
    MCP_SLIDING_WINDOW_SCRIPT,
    1,
    key,
    windowMs,
    limit,
    member
  ) as Promise<ScriptReply>;
}

afterAll(async () => {
  if (redis) {
    await redis.del(KEY);
    await redis.quit();
  }
});

describe.skipIf(redis === null)("MCP sliding-window Lua script", () => {
  beforeEach(async () => {
    await redis?.del(KEY);
  });

  it("admits exactly the limit and then refuses", async () => {
    if (!redis) {
      return;
    }
    const limit = 5;
    const replies: ScriptReply[] = [];
    for (let i = 0; i < limit + 2; i++) {
      replies.push(await evalScript(redis, KEY, 60_000, limit, `m-${i}`));
    }

    expect(replies.slice(0, limit).map((r) => r[0])).toEqual(
      Array.from({ length: limit }, () => 1)
    );
    expect(replies.slice(limit).map((r) => r[0])).toEqual([0, 0]);
    expect(replies.at(-1)?.[1]).toBe(limit);
    expect(await redis.zcard(KEY)).toBe(limit);
  });

  it("returns integer count, oldest score and server clock without precision loss", async () => {
    if (!redis) {
      return;
    }
    const [allowed, count, oldest, now] = await evalScript(
      redis,
      KEY,
      60_000,
      3,
      "m-precision"
    );

    expect(allowed).toBe(1);
    expect(count).toBe(1);
    expect(Number.isInteger(oldest)).toBe(true);
    expect(Number.isInteger(now)).toBe(true);
    expect(oldest).toBe(now);
    // Scored by Redis's clock, not the caller's: the two only have to agree
    // to within normal NTP drift.
    expect(Math.abs(Date.now() - now)).toBeLessThan(5000);
  });

  it("does not collide members written in the same millisecond", async () => {
    if (!redis) {
      return;
    }
    const replies = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        evalScript(redis, KEY, 60_000, 10, `same-ms-${i}`)
      )
    );

    expect(replies.map((r) => r[0])).toEqual([1, 1, 1, 1]);
    expect(await redis.zcard(KEY)).toBe(4);
  });

  it("sets the key TTL on admit and does not extend it on refusal", async () => {
    if (!redis) {
      return;
    }
    await evalScript(redis, KEY, 60_000, 1, "ttl-a");
    const afterAdmit = await redis.pttl(KEY);
    expect(afterAdmit).toBeGreaterThan(0);
    expect(afterAdmit).toBeLessThanOrEqual(60_000);

    const denied = await evalScript(redis, KEY, 60_000, 1, "ttl-b");
    expect(denied[0]).toBe(0);
    // A refused caller must not be able to hold its own window open.
    expect(await redis.pttl(KEY)).toBeLessThanOrEqual(afterAdmit);
  });

  it("trims entries that fall out of the window", async () => {
    if (!redis) {
      return;
    }
    const windowMs = 50;
    expect((await evalScript(redis, KEY, windowMs, 1, "old"))[0]).toBe(1);
    expect((await evalScript(redis, KEY, windowMs, 1, "blocked"))[0]).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, windowMs + 30));

    const afterWindow = await evalScript(redis, KEY, windowMs, 1, "fresh");
    expect(afterWindow[0]).toBe(1);
    expect(afterWindow[1]).toBe(1);
  });
});
