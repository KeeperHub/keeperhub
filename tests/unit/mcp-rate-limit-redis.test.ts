import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockLogSystemWarn, mockIncrementCounter } = vi.hoisted(
  () => ({
    mockGetRedis: vi.fn(),
    mockLogSystemWarn: vi.fn(),
    mockIncrementCounter: vi.fn(),
  })
);

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { INFRASTRUCTURE: "infrastructure" },
  logSystemWarn: mockLogSystemWarn,
}));
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({ incrementCounter: mockIncrementCounter }),
}));

import { MCP_SLIDING_WINDOW_SCRIPT } from "@/lib/mcp/rate-limit";

/**
 * SHA-1 of the Lua the limiter ships, transcribed here rather than derived
 * from the module: everything else in this file drives a JS stand-in for the
 * sorted-set semantics, so nothing here can tell whether the script itself
 * still compiles or still does what the wrapper assumes. Comparing the module
 * constant to itself would prove nothing.
 *
 * If this fails, the Lua changed. Re-verify it against a real Redis with
 * tests/integration/mcp-rate-limit-lua-script.test.ts (its header has the
 * one-line docker command), then update this hash.
 */
const SHIPPED_SCRIPT_SHA1 = "c60d3e1d217beecb927c72a7cd7b3943f270f47a";

type RateLimitModule = typeof import("@/lib/mcp/rate-limit");

type SortedSetEntry = { score: number; member: string };

type FakeRedis = {
  status: string;
  eval: (...args: unknown[]) => Promise<unknown>;
  evalCalls: () => number;
  lastArgs: () => unknown[];
};

/**
 * Stands in for one Redis server: a single store every replica talks to, and
 * a script that runs start to finish without interleaving. The awaited
 * dispatch models the network hop, so concurrent callers genuinely overlap
 * around it -- a limiter that split the check and the increment across two
 * round trips would over-admit against this fake.
 *
 * A real server rejects a missing script and a wrong key count, so this does
 * too. It cannot check what the Lua does -- the golden hash above and the
 * integration suite cover that. The window is scored by this fake's own clock
 * because the real script reads Redis's TIME rather than trusting the caller.
 */
function createFakeRedis(): FakeRedis {
  const store = new Map<string, SortedSetEntry[]>();
  let calls = 0;
  let seen: unknown[] = [];

  const evalScript = async (...args: unknown[]): Promise<unknown> => {
    calls += 1;
    seen = args;
    const [script, numKeys, key, windowMs, limit, member] = args;
    if (script !== MCP_SLIDING_WINDOW_SCRIPT) {
      throw new Error("ERR Error compiling script (new function): unknown");
    }
    if (numKeys !== 1) {
      throw new Error("ERR Number of keys can't be negative");
    }
    await Promise.resolve();

    const nowMs = Date.now();
    const kept = (store.get(String(key)) ?? []).filter(
      (entry) => entry.score > nowMs - Number(windowMs)
    );
    store.set(String(key), kept);

    if (kept.length >= Number(limit)) {
      return [0, kept.length, kept[0].score, nowMs];
    }

    kept.push({ score: nowMs, member: String(member) });
    kept.sort((a, b) => a.score - b.score);
    return [1, kept.length, kept[0].score, nowMs];
  };

  return {
    status: "ready",
    eval: evalScript,
    evalCalls: (): number => calls,
    lastArgs: (): unknown[] => seen,
  };
}

// A fresh module instance stands in for another pod: its own in-memory maps,
// the same shared Redis behind them.
async function loadReplica(): Promise<RateLimitModule> {
  vi.resetModules();
  return await import("@/lib/mcp/rate-limit");
}

describe("checkMcpRateLimit (Redis-backed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enforces one fleet-wide ceiling across replicas sharing a store", async () => {
    mockGetRedis.mockReturnValue(createFakeRedis());

    const podA = await loadReplica();
    const podB = await loadReplica();

    const spread = Array.from({ length: podA.LIMIT }, (_, index) =>
      index % 2 === 0 ? podA : podB
    );
    let allowed = 0;
    for (const pod of spread) {
      const result = await pod.checkMcpRateLimit("org-shared");
      if (result.allowed) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(podA.LIMIT);

    // Each pod served only half the budget; both must still deny, which is
    // the whole point -- per-pod maps gave every replica its own LIMIT.
    const deniedOnB = await podB.checkMcpRateLimit("org-shared");
    const deniedOnA = await podA.checkMcpRateLimit("org-shared");
    expect(deniedOnB.allowed).toBe(false);
    expect(deniedOnA.allowed).toBe(false);

    // Nothing was tracked locally: the decisions came from the shared store.
    expect(podA.getRateLimitStats().organizationCount).toBe(0);
    expect(podB.getRateLimitStats().organizationCount).toBe(0);
  });

  it("admits at most the limit when requests arrive concurrently", async () => {
    const redis = createFakeRedis();
    mockGetRedis.mockReturnValue(redis);

    const pod = await loadReplica();
    const overshoot = 25;
    const attempts = pod.LIMIT + overshoot;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        pod.checkMcpRateLimit("org-concurrent")
      )
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(pod.LIMIT);
    expect(results.filter((r) => !r.allowed)).toHaveLength(overshoot);
    // One round trip per decision: there is no window between the count and
    // the increment for a concurrent request to slip through.
    expect(redis.evalCalls()).toBe(attempts);
  });

  it("reports the standard metadata on both allowed and denied decisions", async () => {
    mockGetRedis.mockReturnValue(createFakeRedis());
    const pod = await loadReplica();

    const first = await pod.checkMcpRateLimit("org-metadata");
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(pod.LIMIT);
    expect(first.remaining).toBe(pod.LIMIT - 1);
    expect(first.reset).toBeGreaterThan(0);

    for (let i = 1; i < pod.LIMIT; i++) {
      await pod.checkMcpRateLimit("org-metadata");
    }

    const denied = await pod.checkMcpRateLimit("org-metadata");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.limit).toBe(pod.LIMIT);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
      expect(denied.reset).toBeGreaterThan(0);
    }
  });

  it("pins the shipped Lua so any change has to be re-verified against a real Redis", () => {
    const digest = createHash("sha1")
      .update(MCP_SLIDING_WINDOW_SCRIPT)
      .digest("hex");
    expect(digest).toBe(SHIPPED_SCRIPT_SHA1);
  });

  it("evaluates the shipped script over exactly one key", async () => {
    const redis = createFakeRedis();
    mockGetRedis.mockReturnValue(redis);
    const pod = await loadReplica();

    await pod.checkMcpRateLimit("org-script");

    const [script, numKeys, key, windowMs, limit] = redis.lastArgs();
    expect(script).toBe(pod.MCP_SLIDING_WINDOW_SCRIPT);
    expect(numKeys).toBe(1);
    expect(key).toBe("local:ratelimit:mcp:org-script");
    expect(windowMs).toBe(pod.WINDOW_MS);
    expect(limit).toBe(pod.LIMIT);
    // The window is scored by Redis's clock, so no caller timestamp is sent.
    expect(pod.MCP_SLIDING_WINDOW_SCRIPT).toContain("redis.call('TIME')");
  });

  it("connects before the first command instead of reporting a cold start as an outage", async () => {
    const backing = createFakeRedis();
    let status = "wait";
    const connect = vi.fn(() => {
      status = "ready";
      return Promise.resolve();
    });
    const client = {
      get status(): string {
        return status;
      },
      connect,
      // ioredis is built with enableOfflineQueue=false, so a command issued
      // before the socket is up is rejected rather than queued.
      eval: (...args: unknown[]): Promise<unknown> =>
        status === "ready"
          ? backing.eval(...args)
          : Promise.reject(
              new Error(
                "Stream isn't writeable and enableOfflineQueue options is false"
              )
            ),
    };
    mockGetRedis.mockReturnValue(client);

    const pod = await loadReplica();
    const first = await pod.checkMcpRateLimit("org-cold-start");

    expect(first.allowed).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    // The decision came from the shared store, and a boot is not an outage.
    expect(pod.getRateLimitStats().organizationCount).toBe(0);
    expect(mockLogSystemWarn).not.toHaveBeenCalled();
    expect(mockIncrementCounter).not.toHaveBeenCalled();

    // The connection is opened once, not once per request.
    await pod.checkMcpRateLimit("org-cold-start");
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("warms the connection at boot without waiting for a request", async () => {
    let status = "wait";
    const connect = vi.fn(() => {
      status = "ready";
      return Promise.resolve();
    });
    mockGetRedis.mockReturnValue({
      get status(): string {
        return status;
      },
      connect,
      eval: (): Promise<unknown> => Promise.resolve([1, 1, Date.now(), 0]),
    });

    const pod = await loadReplica();
    await pod.warmRateLimitRedis();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(status).toBe("ready");
  });

  it("falls back to per-pod limiting rather than open when Redis is unreachable", async () => {
    mockGetRedis.mockReturnValue({
      status: "ready",
      eval: (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const pod = await loadReplica();
    const results: Awaited<ReturnType<RateLimitModule["checkMcpRateLimit"]>>[] =
      [];
    for (let i = 0; i < pod.LIMIT + 5; i++) {
      results.push(await pod.checkMcpRateLimit("org-outage"));
    }

    // Degraded, not disabled: the pod-local window still caps the org.
    expect(results.filter((r) => r.allowed)).toHaveLength(pod.LIMIT);
    expect(results.at(-1)?.allowed).toBe(false);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    expect(mockLogSystemWarn).toHaveBeenCalled();
  });

  it("counts every degraded decision even though the warning is throttled", async () => {
    mockGetRedis.mockReturnValue({
      status: "ready",
      eval: (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const pod = await loadReplica();
    await pod.checkMcpRateLimit("org-counted");
    await pod.checkMcpRateLimit("org-counted");
    await pod.checkMcpRateLimit("org-counted");

    // A throttled log line is not a rate; the counter is what a dashboard can
    // alert on to see the fleet-wide ceiling has reverted to per-pod.
    expect(mockIncrementCounter).toHaveBeenCalledTimes(3);
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "ratelimit.mcp.degraded.total",
      { reason: "command_failed" }
    );
  });

  it("logs the degradation once per interval instead of per request", async () => {
    mockGetRedis.mockReturnValue({
      status: "ready",
      eval: (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const pod = await loadReplica();
    await pod.checkMcpRateLimit("org-noisy");
    await pod.checkMcpRateLimit("org-noisy");
    await pod.checkMcpRateLimit("org-noisy");

    expect(mockLogSystemWarn).toHaveBeenCalledTimes(1);
  });

  it("bounds the fallback map so an outage is not a memory-growth vector", async () => {
    mockGetRedis.mockReturnValue(null);
    const pod = await loadReplica();

    // MAX_TRACKED_KEYS is 10_000; push past it with distinct ids.
    const flood = 10_050;
    for (let i = 0; i < flood; i++) {
      await pod.checkMcpRateLimit(`org-flood-${i}`);
    }

    expect(pod.getRateLimitStats().organizationCount).toBeLessThanOrEqual(
      10_000
    );
  });

  it("bounds the IP map the same way, since anonymous callers can rotate keys", async () => {
    mockGetRedis.mockReturnValue(null);
    const pod = await loadReplica();

    for (let i = 0; i < 10_050; i++) {
      pod.checkIpRateLimit(`10.0.${Math.floor(i / 256)}.${i % 256}`, 5, 60_000);
    }

    expect(pod.getRateLimitStats().ipCount).toBeLessThanOrEqual(10_000);
  });

  it("keeps refusing a key that is at its limit rather than evicting it", async () => {
    mockGetRedis.mockReturnValue(null);
    const pod = await loadReplica();

    const victim = "1.2.3.4";
    for (let i = 0; i < 5; i++) {
      pod.checkIpRateLimit(victim, 5, 60_000);
    }
    expect(pod.checkIpRateLimit(victim, 5, 60_000).allowed).toBe(false);

    // Flood past the cap; the key still being refused is the most recently
    // used one, so LRU eviction must not hand it a fresh window.
    for (let i = 0; i < 10_050; i++) {
      pod.checkIpRateLimit(`10.1.${Math.floor(i / 256)}.${i % 256}`, 5, 60_000);
      pod.checkIpRateLimit(victim, 5, 60_000);
    }
    expect(pod.checkIpRateLimit(victim, 5, 60_000).allowed).toBe(false);
  });

  it("treats an unrecognised reply as a failure and falls back", async () => {
    mockGetRedis.mockReturnValue({
      status: "ready",
      eval: (): Promise<unknown> => Promise.resolve("MOVED 1234"),
    });

    const pod = await loadReplica();
    const result = await pod.checkMcpRateLimit("org-garbled");

    expect(result.allowed).toBe(true);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    expect(mockIncrementCounter).toHaveBeenCalledWith(
      "ratelimit.mcp.degraded.total",
      { reason: "unexpected_reply" }
    );
    // The reply shape is the only diagnostic this branch has; it must reach
    // the error rather than arriving as an Error titled "undefined".
    const reported = mockLogSystemWarn.mock.calls[0][2] as Error;
    expect(reported.message).toContain("MOVED 1234");
  });

  it("uses the in-memory window silently when no Redis is configured", async () => {
    mockGetRedis.mockReturnValue(null);

    const pod = await loadReplica();
    const result = await pod.checkMcpRateLimit("org-unconfigured");

    expect(result.allowed).toBe(true);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    // Self-hosted and local runs have no Redis by design; that is not a
    // degradation worth paging on.
    expect(mockLogSystemWarn).not.toHaveBeenCalled();
    expect(mockIncrementCounter).not.toHaveBeenCalled();
  });

  it("namespaces the counter key per deployment and organization", async () => {
    const redis = createFakeRedis();
    const evalSpy = vi.fn(redis.eval);
    mockGetRedis.mockReturnValue({ status: "ready", eval: evalSpy });

    const pod = await loadReplica();
    await pod.checkMcpRateLimit("org-keyed");

    expect(evalSpy.mock.calls[0][2]).toBe("local:ratelimit:mcp:org-keyed");
  });
});
