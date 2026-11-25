import type { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";
import type {
  ChainProviderManager,
  ChainProviderManagerOptions,
  SubscribeOptions,
} from "../../src/chains/provider-manager";
import { RouteProviderPool } from "../../src/chains/route-provider-pool";
import { RpcTransport } from "../../src/chains/rpc-route";
import type { DedupStore } from "../../src/listener/dedup";
import {
  type AnyRegistration,
  ListenerRegistry,
} from "../../src/listener/registry";
import { buildRegistration } from "../../src/listener/workflow-mapper";
import {
  ORG_FALLBACK_URL,
  ORG_PRIMARY_URL,
  ROUTE_CHAIN_ID,
  makeRoute,
} from "./helpers/route-mocks";

const PLATFORM_WSS = "wss://platform.example/platform-key";
const ABI = JSON.stringify([
  {
    type: "event",
    name: "Emitted",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
]);

const NETWORKS = {
  [ROUTE_CHAIN_ID]: {
    chainId: ROUTE_CHAIN_ID,
    defaultPrimaryWss: PLATFORM_WSS,
    defaultFallbackWss: "",
  },
} as unknown as NetworksMap;

function rawWorkflow(id: string, rpcRoute?: unknown): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: `Workflow ${id}`,
    organizationId: "org-1",
    rpcRoute,
    nodes: [
      {
        data: {
          config: {
            network: String(ROUTE_CHAIN_ID),
            contractAddress: "0x1111111111111111111111111111111111111111",
            eventName: "Emitted",
            contractABI: ABI,
          },
        },
      },
    ],
  };
}

function build(workflow: RawWorkflow): AnyRegistration {
  const reg = buildRegistration(workflow, NETWORKS);
  if (!reg) {
    throw new Error("expected a registration");
  }
  return reg;
}

interface FakeManager {
  manager: ChainProviderManager;
  subscribeToLogs: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  opts: ChainProviderManagerOptions;
}

function fakeManager(opts: ChainProviderManagerOptions): FakeManager {
  const subscribeToLogs = vi.fn(async (_opts: SubscribeOptions) => vi.fn());
  const destroy = vi.fn(async () => undefined);
  return {
    manager: {
      subscribeToLogs,
      destroy,
    } as unknown as ChainProviderManager,
    subscribeToLogs,
    destroy,
    opts,
  };
}

describe("ListenerRegistry with organization routes", () => {
  let platform: FakeManager;
  let routeManagers: FakeManager[];
  let registry: ListenerRegistry;
  let failNextSubscribe: Error | null;

  beforeEach(() => {
    failNextSubscribe = null;
    platform = fakeManager({});
    routeManagers = [];
    const pool = new RouteProviderPool({
      createManager: (opts) => {
        const fake = fakeManager(opts);
        if (failNextSubscribe) {
          fake.subscribeToLogs.mockRejectedValueOnce(failNextSubscribe);
          failNextSubscribe = null;
        }
        routeManagers.push(fake);
        return fake.manager;
      },
    });
    const dedup: DedupStore = {
      isProcessed: vi.fn(async () => false),
      markProcessed: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    registry = new ListenerRegistry({
      providerManager: platform.manager,
      routePool: pool,
      dedup,
      sqs: { send: vi.fn() } as unknown as SQSClient,
      sqsQueueUrl: "https://sqs.test/queue",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps workflows without a route on the shared platform manager", async () => {
    await registry.add(build(rawWorkflow("wf-platform")));
    expect(platform.subscribeToLogs).toHaveBeenCalledTimes(1);
    expect(platform.subscribeToLogs.mock.calls[0][0].wssUrl).toBe(PLATFORM_WSS);
    expect(routeManagers).toHaveLength(0);
  });

  it("listens on the route's endpoints through a manager shared by key", async () => {
    await registry.add(build(rawWorkflow("wf-1", makeRoute())));
    await registry.add(build(rawWorkflow("wf-2", makeRoute())));
    await registry.add(
      build(rawWorkflow("wf-3", makeRoute({ key: "route-b" }))),
    );

    expect(platform.subscribeToLogs).not.toHaveBeenCalled();
    expect(routeManagers).toHaveLength(2);
    const [routeA, routeB] = routeManagers;
    expect(routeA.subscribeToLogs).toHaveBeenCalledTimes(2);
    expect(routeB.subscribeToLogs).toHaveBeenCalledTimes(1);
    const sub = routeA.subscribeToLogs.mock.calls[0][0] as SubscribeOptions;
    expect(sub.wssUrl).toBe(ORG_PRIMARY_URL);
    expect(sub.fallbackWssUrl).toBe(ORG_FALLBACK_URL);
  });

  it("moves a workflow to the new manager when its route key changes", async () => {
    const before = build(rawWorkflow("wf-1", makeRoute()));
    await registry.add(before);
    const after = build(rawWorkflow("wf-1", makeRoute({ key: "route-b" })));

    expect(after.configHash).not.toBe(before.configHash);
    expect(registry.getConfigHash("wf-1")).toBe(before.configHash);

    registry.remove("wf-1");
    await registry.add(after);

    expect(routeManagers).toHaveLength(2);
    expect(routeManagers[0].destroy).toHaveBeenCalledTimes(1);
    expect(routeManagers[1].subscribeToLogs).toHaveBeenCalledTimes(1);
    expect(registry.getConfigHash("wf-1")).toBe(after.configHash);
  });

  it("evicts listeners on a failed route so the next add re-creates it", async () => {
    await registry.add(build(rawWorkflow("wf-1", makeRoute())));
    await registry.add(build(rawWorkflow("wf-platform")));
    routeManagers[0].opts.onPermanentFailure?.(ROUTE_CHAIN_ID);

    expect(registry.evictFailedRoutes()).toBe(1);
    expect(registry.has("wf-1")).toBe(false);
    expect(registry.has("wf-platform")).toBe(true);

    await registry.add(build(rawWorkflow("wf-1", makeRoute())));
    expect(routeManagers).toHaveLength(2);
    expect(routeManagers[1].subscribeToLogs).toHaveBeenCalledTimes(1);
  });

  it("does not log route details when a routed listener fails to start", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    failNextSubscribe = new Error(`all WSS URL(s) failed: ${ORG_PRIMARY_URL}`);
    await registry.add(build(rawWorkflow("wf-1", makeRoute())));

    expect(registry.has("wf-1")).toBe(false);
    expect(routeManagers[0].destroy).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("wf-1");
    expect(logged).not.toContain("org-primary");
    expect(logged).not.toContain("route-a");
  });
});

describe("buildRegistration with rpcRoute", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the route's endpoints and includes the key in the config hash", () => {
    const routed = build(rawWorkflow("wf-1", makeRoute()));
    const platformReg = build(rawWorkflow("wf-1"));
    expect(routed.wssUrl).toBe(ORG_PRIMARY_URL);
    expect(routed.fallbackWssUrl).toBe(ORG_FALLBACK_URL);
    expect(routed.rpcRoute?.key).toBe("route-a");
    expect(platformReg.rpcRoute).toBeUndefined();
    expect(platformReg.wssUrl).toBe(PLATFORM_WSS);
    expect(routed.configHash).not.toBe(platformReg.configHash);
  });

  it("refuses unusable routes without logging their URLs", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const http = rawWorkflow(
      "wf-http",
      makeRoute({ transport: RpcTransport.HTTP }),
    );
    const malformed = rawWorkflow("wf-bad", { key: "k", primary: {} });
    const wrongChain = rawWorkflow("wf-chain", makeRoute({ chainId: 1 }));
    const httpUrl = rawWorkflow(
      "wf-url",
      makeRoute({
        primary: {
          url: "https://org-primary.example/secret-key-1",
          origin: "org",
          configId: "cfg-1",
        },
      }),
    );

    for (const workflow of [http, malformed, wrongChain, httpUrl]) {
      expect(buildRegistration(workflow, NETWORKS)).toBeNull();
    }
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("org-primary");
    expect(logged).not.toContain("secret-key");
  });
});
