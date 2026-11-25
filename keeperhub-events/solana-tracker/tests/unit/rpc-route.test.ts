import type { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryData,
  NetworkConfig,
  RawWorkflow,
} from "../../lib/types";
import { signHmacHeaders } from "../../lib/utils/fetch-utils";
import { silentLogger } from "../../lib/utils/logger";
import type { DedupStore } from "../../src/dedup";
import { resetFakeWeb3 } from "./helpers/fake-web3";

const APP_URL = "http://app.test";

const fake = await vi.hoisted(async () => {
  process.env.KEEPERHUB_API_URL = "http://app.test";
  const { createFakeWeb3State } = await import("./helpers/fake-web3");
  return createFakeWeb3State();
});

vi.mock("@solana/web3.js", async (importActual) => {
  const actual = await importActual<typeof import("@solana/web3.js")>();
  const { makeFakeConnection } = await import("./helpers/fake-web3");
  return { ...actual, Connection: makeFakeConnection(fake) };
});

const { buildRegistrations, buildRouteRegistrations } = await import(
  "../../src/mapper"
);
const { BlockIngestor } = await import("../../src/ingest/block-ingestor");
const { RoutePool } = await import("../../src/rpc-route/route-pool");
const { UsageMeter } = await import("../../src/rpc-route/usage-meter");
const { createUsageReporter, flushUsage, postSigned } = await import(
  "../../src/rpc-route/usage-reporter"
);
const { RPC_USAGE_INGEST_PATH, RpcOrigin, RpcTransport, UsageCounter } =
  await import("../../src/rpc-route/constants");

type UsageMeterType = InstanceType<typeof UsageMeter>;

const ORG_PRIMARY = "https://org-primary.example/secret-key-1";
const ORG_FALLBACK = "https://org-fallback.example/secret-key-2";

function solanaNetwork(chainId: number): NetworkConfig {
  return {
    id: `chain-${chainId}`,
    chainId,
    name: `Solana ${chainId}`,
    symbol: "SOL",
    chainType: "solana",
    defaultPrimaryRpc: "https://platform-rpc.example",
    defaultFallbackRpc: "",
    defaultPrimaryWss: "wss://platform-ws.example",
    defaultFallbackWss: "",
    isTestnet: false,
    isEnabled: true,
  };
}

function route(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    organizationId: "org-1",
    chainId: 101,
    transport: RpcTransport.HTTP,
    primary: { url: ORG_PRIMARY, origin: RpcOrigin.ORG, configId: "cfg-1" },
    fallback: {
      url: ORG_FALLBACK,
      origin: RpcOrigin.ORG,
      configId: "cfg-1",
    },
    ...overrides,
  };
}

function blockWorkflow(id: string, rpcRoute?: unknown): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: { triggerType: "Block", network: "101", blockInterval: "1" },
        },
      },
    ],
    ...(rpcRoute === undefined ? {} : { rpcRoute }),
  };
}

function discovery(blockWorkflows: RawWorkflow[]): DiscoveryData {
  return {
    eventWorkflows: [],
    blockWorkflows,
    networks: { 101: solanaNetwork(101) },
  };
}

const dedup: DedupStore = {
  isProcessed: () => Promise.resolve(false),
  markProcessed: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
};

function routePool(meter: UsageMeterType) {
  return new RoutePool(
    (registration, endpointUsage) =>
      new BlockIngestor({
        registration,
        sqs: {} as SQSClient,
        sqsQueueUrl: "",
        dedup,
        logger: silentLogger,
        endpointUsage,
      }),
    meter,
  );
}

beforeEach(() => {
  resetFakeWeb3(fake);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("route registrations", () => {
  it("groups routed workflows by route key and keeps them off the platform chain", () => {
    const data = discovery([
      blockWorkflow("wf-platform"),
      blockWorkflow("wf-a", route("key-a")),
      blockWorkflow("wf-b", route("key-a")),
      blockWorkflow("wf-c", route("key-c")),
    ]);

    const platform = buildRegistrations(data);
    expect(platform).toHaveLength(1);
    expect(platform[0].route).toBeUndefined();
    expect(platform[0].rpcUrl).toBe("https://platform-rpc.example");
    expect(platform[0].wssUrl).toBe("wss://platform-ws.example");
    expect(platform[0].blockTriggers.map((t) => t.workflowId)).toEqual([
      "wf-platform",
    ]);

    const routes = buildRouteRegistrations(data);
    expect(routes.map((r) => r.route.key).sort()).toEqual(["key-a", "key-c"]);
    const shared = routes.find((r) => r.route.key === "key-a");
    expect(shared?.blockTriggers.map((t) => t.workflowId).sort()).toEqual([
      "wf-a",
      "wf-b",
    ]);
    expect(shared?.rpcUrl).toBe(ORG_PRIMARY);
    expect(shared?.fallbackRpcUrl).toBe(ORG_FALLBACK);
    expect(shared?.wssUrl).toBeUndefined();
  });

  it("serves a malformed route nowhere", () => {
    const data = discovery([
      blockWorkflow("wf-bad", route("key-x", { transport: RpcTransport.WSS })),
    ]);
    expect(buildRegistrations(data)).toEqual([]);
    expect(buildRouteRegistrations(data)).toEqual([]);
  });
});

describe("RoutePool", () => {
  it("shares one connection per route key, built from the route's URL", async () => {
    const pool = routePool(new UsageMeter());
    await pool.reconcile(
      buildRouteRegistrations(
        discovery([
          blockWorkflow("wf-a", route("key-a")),
          blockWorkflow("wf-b", route("key-a")),
        ]),
      ),
    );

    expect(pool.keys()).toEqual(["key-a"]);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0].rpcUrl).toBe(ORG_PRIMARY);
    // Left to web3.js, which derives the socket from the RPC URL.
    expect(fake.instances[0].wsEndpoint).toBeUndefined();
    await pool.stopAll();
  });

  it("moves a workflow to the new connection when its route key changes", async () => {
    const pool = routePool(new UsageMeter());
    await pool.reconcile(
      buildRouteRegistrations(
        discovery([blockWorkflow("wf-a", route("key-a"))]),
      ),
    );
    const first = fake.instances[0];

    const moved = route("key-b", {
      primary: {
        url: "https://org-other.example/k",
        origin: RpcOrigin.ORG,
        configId: "cfg-2",
      },
    });
    await pool.reconcile(
      buildRouteRegistrations(discovery([blockWorkflow("wf-a", moved)])),
    );

    expect(pool.keys()).toEqual(["key-b"]);
    expect(first.removed).toBe(true);
    expect(fake.instances.at(-1)?.rpcUrl).toBe("https://org-other.example/k");
    await pool.stopAll();
  });

  it("tears down a failed route without logging or exiting, then rebuilds it next poll", async () => {
    const out = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    fake.subscribeThrows.add(ORG_PRIMARY);
    fake.rpcRejects.add(ORG_PRIMARY);
    const pool = routePool(new UsageMeter());
    const registrations = buildRouteRegistrations(
      discovery([
        blockWorkflow("wf-a", route("key-a", { fallback: undefined })),
      ]),
    );

    await pool.reconcile(registrations);
    expect(pool.keys()).toEqual(["key-a"]);

    await pool.reconcile(registrations);
    expect(pool.keys()).toEqual([]);

    fake.subscribeThrows.clear();
    fake.rpcRejects.clear();
    await pool.reconcile(registrations);
    expect(pool.keys()).toEqual(["key-a"]);
    await pool.stopAll();

    for (const spy of out) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it("counts usage against the endpoint serving it", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T10:15:00Z") });
    const meter = new UsageMeter();
    const pool = routePool(meter);
    await pool.reconcile(
      buildRouteRegistrations(
        discovery([blockWorkflow("wf-a", route("key-a"))]),
      ),
    );
    fake.instances[0].fireSlot(101);
    fake.instances[0].fireSlot(102);
    await vi.advanceTimersByTimeAsync(0);
    await pool.stopAll();

    const buckets = meter.drain();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      organizationId: "org-1",
      configId: "cfg-1",
      origin: RpcOrigin.ORG,
      chainId: 101,
      transport: RpcTransport.HTTP,
      hour: "2026-11-25T10:00:00.000Z",
    });
    expect(buckets[0].counters[UsageCounter.WS_CONNECTS]).toBe(1);
    expect(buckets[0].counters[UsageCounter.EVENTS_RECEIVED]).toBe(2);
    expect(buckets[0].counters[UsageCounter.REQUESTS]).toBeGreaterThanOrEqual(
      1,
    );
    expect(JSON.stringify(buckets)).not.toContain("secret-key");
  });
});

describe("usage reporting", () => {
  const dims = {
    organizationId: "org-1",
    configId: "cfg-1",
    origin: RpcOrigin.ORG,
    chainId: 101,
    transport: RpcTransport.HTTP,
  };

  it("aggregates per UTC hour and endpoint and posts the documented body", async () => {
    let now = Date.parse("2026-11-25T10:59:00Z");
    const meter = new UsageMeter(100, () => now);
    meter.record(dims, UsageCounter.REQUESTS);
    meter.record(dims, UsageCounter.REQUESTS, 2);
    meter.record(
      { ...dims, configId: null, origin: RpcOrigin.PLATFORM },
      UsageCounter.ERRORS,
    );
    now = Date.parse("2026-11-25T11:00:01Z");
    meter.record(dims, UsageCounter.WS_RECONNECTS);

    const post = vi.fn((_path: string, _body: string) => Promise.resolve(true));
    await flushUsage(meter, post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(RPC_USAGE_INGEST_PATH);
    expect(JSON.parse(post.mock.calls[0][1])).toEqual({
      buckets: [
        {
          ...dims,
          hour: "2026-11-25T10:00:00.000Z",
          counters: { requests: 3 },
        },
        {
          ...dims,
          configId: null,
          origin: RpcOrigin.PLATFORM,
          hour: "2026-11-25T10:00:00.000Z",
          counters: { errors: 1 },
        },
        {
          ...dims,
          hour: "2026-11-25T11:00:00.000Z",
          counters: { wsReconnects: 1 },
        },
      ],
    });
    expect(meter.size).toBe(0);
  });

  it("sends at most 1000 buckets per request", async () => {
    const meter = new UsageMeter();
    for (let i = 0; i < 2500; i++) {
      meter.record({ ...dims, configId: `cfg-${i}` }, UsageCounter.REQUESTS);
    }
    const sizes: number[] = [];
    await flushUsage(meter, (_path, body) => {
      sizes.push((JSON.parse(body) as { buckets: unknown[] }).buckets.length);
      return Promise.resolve(true);
    });
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it("keeps counts from a failed post for the next attempt, within a bound", async () => {
    const meter = new UsageMeter(2);
    meter.record(dims, UsageCounter.REQUESTS, 4);
    await flushUsage(meter, () => Promise.reject(new Error("down")));
    meter.record(dims, UsageCounter.REQUESTS);
    expect(meter.size).toBe(1);

    const bodies: string[] = [];
    await flushUsage(meter, (_path, body) => {
      bodies.push(body);
      return Promise.resolve(true);
    });
    expect(JSON.parse(bodies[0]).buckets[0].counters).toEqual({ requests: 5 });

    meter.record({ ...dims, configId: "a" }, UsageCounter.REQUESTS);
    meter.record({ ...dims, configId: "b" }, UsageCounter.REQUESTS);
    meter.record({ ...dims, configId: "c" }, UsageCounter.REQUESTS);
    expect(meter.drain().map((b) => b.configId)).toEqual(["b", "c"]);
  });

  it("flushes once more on stop", async () => {
    const meter = new UsageMeter();
    const post = vi.fn(() => Promise.resolve(true));
    const reporter = createUsageReporter(meter, post, 60_000);
    reporter.start();
    meter.record(dims, UsageCounter.EVENTS_RECEIVED);
    await reporter.stop();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("signs the exact raw body it posts", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T10:00:00Z") });
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({ buckets: [] });

    expect(await postSigned(RPC_USAGE_INGEST_PATH, body)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${APP_URL}${RPC_USAGE_INGEST_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(init.headers).toMatchObject(
      signHmacHeaders("POST", url, body, "events"),
    );
  });
});
