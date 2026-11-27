import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChainProviderManager,
  type ChainProviderManagerOptions,
  silentLogger,
} from "../../src/chains/provider-manager";
import { RouteProviderPool } from "../../src/chains/route-provider-pool";
import { RpcOrigin, RpcUsageCounter } from "../../src/chains/rpc-route";
import { buildHealthResponse } from "../../src/health/health-server";
import { RpcUsageReporter } from "../../src/usage/rpc-usage-reporter";
import {
  ORG_FALLBACK_URL,
  ORG_ID,
  ORG_PRIMARY_URL,
  ROUTE_CHAIN_ID,
  makeMockFactory,
  makeRoute,
} from "./helpers/route-mocks";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const TOPIC =
  "0x6d7747ff9aaba238de658957a12a32c8a94f6ec3aa0508441fe400ca79ed457c";

function subscribeOn(
  manager: ChainProviderManager,
  wssUrl: string,
  fallbackWssUrl?: string,
): Promise<() => void> {
  return manager.subscribeToLogs({
    chainId: ROUTE_CHAIN_ID,
    wssUrl,
    fallbackWssUrl,
    address: ADDRESS,
    topic0: TOPIC,
    handler: vi.fn(),
  });
}

describe("RouteProviderPool", () => {
  let mocks: ReturnType<typeof makeMockFactory>;
  let pool: RouteProviderPool;

  beforeEach(() => {
    mocks = makeMockFactory();
    pool = new RouteProviderPool({
      managerOptions: { factory: mocks.factory },
    });
  });

  afterEach(async () => {
    await pool.destroyAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shares one manager per route key and separates different keys", () => {
    const a1 = pool.acquire(makeRoute());
    const a2 = pool.acquire(makeRoute());
    const b = pool.acquire(makeRoute({ key: "route-b" }));
    expect(a1.manager).toBe(a2.manager);
    expect(b.manager).not.toBe(a1.manager);
    expect(pool.size()).toBe(2);
  });

  it("destroys a route's manager when its last lease is released", async () => {
    const first = pool.acquire(makeRoute());
    const second = pool.acquire(makeRoute());
    const destroy = vi.spyOn(first.manager, "destroy");
    first.release();
    first.release();
    expect(pool.has("route-a")).toBe(true);
    second.release();
    expect(pool.has("route-a")).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("gives pool managers a silent logger and a non-exiting failure handler", () => {
    const seen: ChainProviderManagerOptions[] = [];
    const spyPool = new RouteProviderPool({
      createManager: (opts) => {
        seen.push(opts);
        return new ChainProviderManager(opts);
      },
    });
    spyPool.acquire(makeRoute());
    expect(seen).toHaveLength(1);
    expect(seen[0].logger).toBe(silentLogger);
    expect(typeof seen[0].onPermanentFailure).toBe("function");
    expect(typeof seen[0].onUsage).toBe("function");
  });

  it("writes nothing to stdout or stderr while serving a route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const lease = pool.acquire(makeRoute());
    await subscribeOn(lease.manager, ORG_PRIMARY_URL, ORG_FALLBACK_URL);
    const provider = mocks.created[0];
    provider.getLogsResponses.push(new Error("upstream rejected"));
    await provider.emitBlock(100);
    await provider.emitBlock(101);
    provider.emitError(new Error("socket dropped"));

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("tears down a permanently failed route without exiting, and re-creates it on the next acquire", async () => {
    vi.useFakeTimers();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const lease = pool.acquire(makeRoute());
    await subscribeOn(lease.manager, ORG_PRIMARY_URL, ORG_FALLBACK_URL);

    mocks.failWith(new Error("upstream down"));
    mocks.created[0].emitError(new Error("drop"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(exit).not.toHaveBeenCalled();
    expect(lease.failed).toBe(true);
    expect(pool.has("route-a")).toBe(false);

    mocks.failWith(null);
    const next = pool.acquire(makeRoute());
    expect(next.manager).not.toBe(lease.manager);
    expect(next.failed).toBe(false);
    lease.release();
    expect(pool.has("route-a")).toBe(true);
  });

  it("attributes usage to the endpoint that served it", async () => {
    const usage = new RpcUsageReporter({
      send: vi.fn(async () => 200),
      now: () => Date.UTC(2026, 0, 1, 10, 15),
    });
    const usagePool = new RouteProviderPool({
      managerOptions: { factory: mocks.factory },
      usage,
    });
    const lease = usagePool.acquire(makeRoute());
    await subscribeOn(lease.manager, ORG_PRIMARY_URL, ORG_FALLBACK_URL);
    const provider = mocks.created[0];
    provider.getLogsResponses.push([
      {
        address: ADDRESS,
        topics: [TOPIC],
        data: "0x",
        blockNumber: 100,
        transactionHash: `0x${"a".repeat(64)}`,
        index: 0,
      },
    ]);
    await provider.emitBlock(100);
    await usagePool.destroyAll();

    const buckets = usage.pendingBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toEqual({
      organizationId: ORG_ID,
      configId: "cfg-1",
      origin: RpcOrigin.ORG,
      chainId: ROUTE_CHAIN_ID,
      transport: "wss",
      hour: "2026-01-01T10:00:00.000Z",
      counters: {
        [RpcUsageCounter.WS_CONNECTS]: 1,
        [RpcUsageCounter.REQUESTS]: 1,
        [RpcUsageCounter.EVENTS_RECEIVED]: 1,
      },
    });
  });

  it("keeps organization routes out of /healthz", async () => {
    const platform = new ChainProviderManager({ factory: mocks.factory });
    await subscribeOn(platform, "wss://platform.example/key");
    const lease = pool.acquire(makeRoute());
    await subscribeOn(lease.manager, ORG_PRIMARY_URL, ORG_FALLBACK_URL);

    const { body } = buildHealthResponse(platform);
    expect(body.chains).toHaveLength(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("org-primary");
    expect(serialized).not.toContain("org-fallback");
    await platform.destroy();
  });
});
