import { EventEmitter } from "node:events";
import type { LookupFunction } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockMonitorService } from "../../block-dispatcher/monitor-service.js";
import { enqueueBlockTrigger } from "../../block-dispatcher/sqs-enqueue.js";
import { RECONCILE_INTERVAL_MS } from "../../lib/config.js";
import { metrics, registry } from "../../lib/metrics.js";
import {
  RPC_USAGE_INGEST_PATH,
  RpcOrigin,
  RpcTransport,
} from "../../lib/rpc-route.js";
import type { RpcUsageBucket } from "../../lib/rpc-usage.js";
import type { FetchBlockWorkflowsResponse, RpcRoute } from "../../lib/types.js";

const { apiRequest, postSignedOnce } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  postSignedOnce: vi.fn(),
}));
vi.mock("../../lib/http-client.js", () => ({
  apiRequest,
  postSignedOnce,
  apiRequestWithAttempts: vi.fn(),
}));

vi.mock("../../block-dispatcher/sqs-enqueue.js", () => ({
  enqueueBlockTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/phantom.js", () => ({
  createPhantomExecution: vi.fn().mockResolvedValue({ alreadyExisted: false }),
  failPhantomExecution: vi.fn(),
}));

class MockWebSocket extends EventEmitter {
  readyState = 1;
  ping(): void {
    setTimeout(() => this.emit("pong"), 0);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

type BlockListener = (blockNumber: number) => void;

class MockProvider {
  readonly websocket = new MockWebSocket();
  destroyed = false;
  private blockListeners: BlockListener[] = [];

  constructor(readonly url: string) {}

  getBlockNumber(): Promise<number> {
    if (failingUrls.has(this.url)) {
      return Promise.reject(new Error(`connect refused for ${this.url}`));
    }
    return Promise.resolve(100);
  }

  getBlock(
    blockNumber: number,
  ): Promise<{ hash: string; timestamp: number; parentHash: string }> {
    return Promise.resolve({
      hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      timestamp: Math.floor(Date.now() / 1000),
      parentHash: `0x${(blockNumber - 1).toString(16).padStart(64, "0")}`,
    });
  }

  on(event: string, listener: BlockListener): Promise<this> {
    if (event === "block") {
      this.blockListeners.push(listener);
    }
    return Promise.resolve(this);
  }

  removeAllListeners(): Promise<this> {
    this.blockListeners = [];
    return Promise.resolve(this);
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }

  emitBlock(blockNumber: number): void {
    for (const listener of this.blockListeners) {
      listener(blockNumber);
    }
  }
}

const providers: MockProvider[] = [];
const failingUrls = new Set<string>();

type MockSocket = { url: string; options?: { lookup?: LookupFunction } };
const sockets: MockSocket[] = [];

vi.mock("ws", () => ({
  WebSocket: class {
    constructor(
      readonly url: string,
      readonly options?: { lookup?: LookupFunction },
    ) {
      sockets.push(this);
    }
  },
}));

vi.mock("ethers", () => ({
  ethers: {
    WebSocketProvider: class {
      constructor(target: string | (() => MockSocket)) {
        const url = typeof target === "string" ? target : target().url;
        const instance = new MockProvider(url);
        providers.push(instance);
        // biome-ignore lint/correctness/noConstructorReturn: substitutes the mock instance for `new`
        return instance;
      }
    },
  },
}));

const PLATFORM_PRIMARY = "wss://platform-primary.test";
const PLATFORM_FALLBACK = "wss://platform-fallback.test";
const ORG_CHAIN_NAME = "Polygon";

function route(key: string, chainId = 1): RpcRoute {
  return {
    key,
    organizationId: "org-1",
    chainId,
    transport: RpcTransport.WSS,
    primary: {
      url: `wss://org-${key}-primary.test/secret-key`,
      origin: RpcOrigin.ORG,
      configId: `cfg-${key}`,
      addresses: ["203.0.113.10"],
    },
    fallback: {
      url: `wss://platform-${key}-fallback.test`,
      origin: RpcOrigin.PLATFORM,
      configId: null,
    },
  };
}

type WorkflowSpec = { id: string; chainId?: number; rpcRoute?: RpcRoute };

function serve(specs: WorkflowSpec[]): void {
  const response: FetchBlockWorkflowsResponse = {
    workflows: specs.map(({ id, chainId = 1, rpcRoute }) => ({
      id,
      name: `Workflow ${id}`,
      userId: "user-1",
      organizationId: rpcRoute ? rpcRoute.organizationId : null,
      enabled: true,
      rpcRoute,
      nodes: [
        { data: { config: { network: String(chainId), blockInterval: "5" } } },
      ],
    })),
    networks: {
      1: {
        chainId: 1,
        name: "Ethereum Mainnet",
        defaultPrimaryWss: PLATFORM_PRIMARY,
        defaultFallbackWss: PLATFORM_FALLBACK,
      },
      137: {
        chainId: 137,
        name: ORG_CHAIN_NAME,
        defaultPrimaryWss: "wss://polygon-primary.test",
        defaultFallbackWss: null,
      },
    },
  };
  apiRequest.mockResolvedValue(response);
}

function liveProvider(url: string): MockProvider {
  const match = providers.filter((p) => p.url === url && !p.destroyed);
  expect(match).toHaveLength(1);
  return match[0];
}

function enqueuedWorkflowIds(): string[] {
  return vi
    .mocked(enqueueBlockTrigger)
    .mock.calls.map(([message]) => message.workflowId)
    .sort();
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

async function nextReconcile(): Promise<void> {
  await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
}

describe("BlockMonitorService organization routes", () => {
  let service: BlockMonitorService;
  let logged: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    providers.length = 0;
    sockets.length = 0;
    failingUrls.clear();
    apiRequest.mockReset();
    postSignedOnce.mockReset().mockResolvedValue(200);
    vi.mocked(enqueueBlockTrigger).mockClear();
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    service = new BlockMonitorService();
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    metrics.resetForTests();
  });

  it("dials an organization endpoint only at its vetted addresses", async () => {
    serve([{ id: "org-b", rpcRoute: route("k1") }]);

    await service.start();
    await settle();

    const socket = sockets.find((s) => s.url === route("k1").primary.url);
    const lookup = socket?.options?.lookup;
    expect(lookup).toBeDefined();
    const answer = await new Promise<string>((resolve) => {
      lookup?.("internal.example", {}, (_err, address) =>
        resolve(String(address)),
      );
    });
    expect(answer).toBe("203.0.113.10");
  });

  it("skips an organization route that carries no vetted addresses", async () => {
    const unvetted = route("k1");
    unvetted.primary = { ...unvetted.primary, addresses: undefined };
    serve([{ id: "org-b", rpcRoute: unvetted }]);

    await service.start();
    await settle();

    expect(providers.map((p) => p.url)).not.toContain(unvetted.primary.url);
  });

  it("shares one monitor per route key, built from the route's endpoints", async () => {
    serve([
      { id: "platform-a" },
      { id: "org-b", rpcRoute: route("k1") },
      { id: "org-c", rpcRoute: route("k1") },
      { id: "org-d", rpcRoute: route("k2") },
    ]);

    await service.start();
    await settle();

    expect(providers.map((p) => p.url).sort()).toEqual(
      [
        PLATFORM_PRIMARY,
        route("k1").primary.url,
        route("k2").primary.url,
      ].sort(),
    );
    expect(service.getHealth().monitors).toHaveLength(1);
  });

  it("dispatches each monitor's own workflows only", async () => {
    serve([
      { id: "platform-a" },
      { id: "org-b", rpcRoute: route("k1") },
      { id: "org-c", rpcRoute: route("k1") },
    ]);
    await service.start();
    await settle();

    liveProvider(PLATFORM_PRIMARY).emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["platform-a"]);

    vi.mocked(enqueueBlockTrigger).mockClear();
    liveProvider(route("k1").primary.url).emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["org-b", "org-c"]);
  });

  it("stops dispatching a workflow from the platform monitor once it has a route", async () => {
    serve([{ id: "platform-a" }, { id: "platform-e" }]);
    await service.start();
    await settle();
    const platform = liveProvider(PLATFORM_PRIMARY);

    serve([{ id: "platform-a", rpcRoute: route("k1") }, { id: "platform-e" }]);
    await nextReconcile();

    expect(liveProvider(PLATFORM_PRIMARY)).toBe(platform);
    platform.emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["platform-e"]);

    vi.mocked(enqueueBlockTrigger).mockClear();
    liveProvider(route("k1").primary.url).emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["platform-a"]);
  });

  it("moves a workflow to the new monitor when its route key changes", async () => {
    serve([
      { id: "org-b", rpcRoute: route("k1") },
      { id: "org-c", rpcRoute: route("k1") },
    ]);
    await service.start();
    await settle();
    const k1 = liveProvider(route("k1").primary.url);

    serve([
      { id: "org-b", rpcRoute: route("k1") },
      { id: "org-c", rpcRoute: route("k3") },
    ]);
    await nextReconcile();
    await settle();

    k1.emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["org-b"]);

    vi.mocked(enqueueBlockTrigger).mockClear();
    liveProvider(route("k3").primary.url).emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["org-c"]);

    serve([{ id: "org-c", rpcRoute: route("k3") }]);
    await nextReconcile();
    expect(k1.destroyed).toBe(true);
  });

  it("keeps organization monitors out of logs and Prometheus", async () => {
    const orgRoute = route("k9", 137);
    serve([{ id: "platform-a" }, { id: "org-x", rpcRoute: orgRoute }]);
    await service.start();
    await settle();

    liveProvider(orgRoute.primary.url).emitBlock(10);
    await settle();
    liveProvider(orgRoute.primary.url).websocket.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await nextReconcile();

    expect(vi.mocked(enqueueBlockTrigger)).toHaveBeenCalled();
    const output = logged.join("\n");
    expect(output).not.toContain("org-k9");
    expect(output).not.toContain("platform-k9");
    expect(output).not.toContain("k9");
    expect(output).not.toContain(`BlockMonitor:${ORG_CHAIN_NAME}`);
    expect(output).toContain("BlockMonitor:Ethereum Mainnet");

    const series = await registry.metrics();
    expect(series).not.toContain(ORG_CHAIN_NAME);
    expect(series).toContain('chain="Ethereum Mainnet"');
  });

  it("drops a failing organization monitor without touching platform chains", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const orgRoute = route("k1");
    failingUrls.add(orgRoute.primary.url);
    failingUrls.add(orgRoute.fallback?.url ?? "");
    serve([{ id: "platform-a" }, { id: "org-b", rpcRoute: orgRoute }]);

    await service.start();
    await settle();
    const attempts = providers.filter(
      (p) => p.url === orgRoute.primary.url,
    ).length;

    expect(exit).not.toHaveBeenCalled();
    expect(service.getHealth()).toMatchObject({ healthy: true, status: "ok" });
    liveProvider(PLATFORM_PRIMARY).emitBlock(10);
    await settle();
    expect(enqueuedWorkflowIds()).toEqual(["platform-a"]);

    failingUrls.clear();
    await nextReconcile();
    await settle();
    expect(providers.filter((p) => p.url === orgRoute.primary.url).length).toBe(
      attempts + 1,
    );
    expect(liveProvider(orgRoute.primary.url).destroyed).toBe(false);
  });

  it("stops a dead organization monitor and recreates it on the next poll", async () => {
    vi.stubEnv("MONITOR_RECREATE_TIMEOUT_MS", "1000");
    const orgRoute = route("k1");
    serve([{ id: "org-b", rpcRoute: orgRoute }]);
    await service.start();
    await settle();
    const first = liveProvider(orgRoute.primary.url);

    await nextReconcile();
    expect(first.destroyed).toBe(true);
    expect(
      providers.filter((p) => p.url === orgRoute.primary.url && !p.destroyed),
    ).toHaveLength(0);

    await nextReconcile();
    await settle();
    expect(liveProvider(orgRoute.primary.url)).not.toBe(first);
  });

  it("reports usage per serving endpoint without urls", async () => {
    const orgRoute = route("k1");
    serve([{ id: "platform-a" }, { id: "org-b", rpcRoute: orgRoute }]);
    await service.start();
    await settle();
    liveProvider(orgRoute.primary.url).emitBlock(10);
    liveProvider(PLATFORM_PRIMARY).emitBlock(10);
    await settle();

    await service.stop();

    expect(postSignedOnce).toHaveBeenCalledTimes(1);
    const [path, body] = postSignedOnce.mock.calls[0] as [string, string];
    expect(path).toBe(RPC_USAGE_INGEST_PATH);
    expect(body).not.toContain("wss://");
    const { buckets } = JSON.parse(body) as { buckets: RpcUsageBucket[] };
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      organizationId: "org-1",
      configId: "cfg-k1",
      origin: RpcOrigin.ORG,
      chainId: 1,
      transport: RpcTransport.WSS,
    });
    // connect probe, eth_subscribe and one getBlock for the matched block
    expect(buckets[0].counters).toEqual({
      requests: 3,
      wsConnects: 1,
      eventsReceived: 1,
    });
  });
});
