import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const engine = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock("@/lib/rpc/engine/runtime", () => ({
  getRpcEngine: () => engine,
}));
const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/rpc/engine/public-endpoint", () => ({
  resolveEndpointAddresses: resolver.resolve,
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logWarn: vi.fn(),
}));

import { RpcRouteError, RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import {
  attachTriggerRoutes,
  type TriggerWorkflow,
  triggerChainId,
} from "@/lib/rpc/engine/trigger-routes";
import {
  RpcChainType,
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  RpcScopeKind,
  RpcSelectionMode,
  RpcTransport,
} from "@/lib/rpc/engine/types";

const ORG_ID = "org_1";
const CHAIN_ID = 1;
const ORG_WSS = "wss://org.example.com/key";
const PUBLIC_ADDRESS = "203.0.113.10";

function endpoint(origin: RpcOrigin, url: string): RpcEndpoint {
  return {
    origin,
    role: RpcEndpointRole.PRIMARY,
    transport: RpcTransport.WSS,
    url: SecretUrl.parse(url),
    configId: origin === RpcOrigin.ORG ? "cfg_main" : null,
    configName: null,
  };
}

function route(primary: RpcEndpoint): RpcRoute {
  return {
    key: "route-key",
    chain: {
      chainId: CHAIN_ID,
      name: "Ethereum",
      chainType: RpcChainType.EVM,
      isEnabled: true,
    },
    transport: RpcTransport.WSS,
    primary,
    organizationId: ORG_ID,
    ownRpcOnly: false,
    notices: [],
  };
}

function workflow(
  id: string,
  config: Record<string, unknown>,
  organizationId: string | null = ORG_ID
): TriggerWorkflow {
  return { id, organizationId, nodes: [{ data: { config } }] };
}

describe("triggerChainId", () => {
  it("reads numeric networks and ignores anything else", () => {
    expect(triggerChainId({ data: { config: { network: "8453" } } })).toBe(
      8453
    );
    expect(triggerChainId({ data: { config: { network: "base" } } })).toBe(
      null
    );
    expect(triggerChainId(undefined)).toBe(null);
  });
});

describe("attachTriggerRoutes", () => {
  beforeEach(() => {
    engine.route.mockReset();
    resolver.resolve.mockReset();
    resolver.resolve.mockResolvedValue([PUBLIC_ADDRESS]);
  });

  it("leaves KeeperHub routes alone so the shared per-chain socket serves them", async () => {
    engine.route.mockResolvedValue(
      route(endpoint(RpcOrigin.PLATFORM, "wss://kh.example.com/key"))
    );
    const [result] = await attachTriggerRoutes([
      workflow("wf_1", { network: String(CHAIN_ID) }),
    ]);
    expect(result.rpcRoute).toBeUndefined();
  });

  it("hands the organization's endpoints to the trigger services", async () => {
    engine.route.mockResolvedValue(route(endpoint(RpcOrigin.ORG, ORG_WSS)));
    const [result] = await attachTriggerRoutes([
      workflow("wf_1", {
        network: String(CHAIN_ID),
        [RPC_SELECTION_CONFIG_KEY]: "cfg_main",
      }),
    ]);

    expect(engine.route).toHaveBeenCalledWith(
      {
        kind: RpcScopeKind.ORG,
        organizationId: ORG_ID,
        selection: { mode: RpcSelectionMode.CONFIG, configId: "cfg_main" },
      },
      CHAIN_ID,
      { purpose: RpcPurpose.SUBSCRIBE }
    );
    expect(result.rpcRoute).toEqual({
      key: "route-key",
      organizationId: ORG_ID,
      chainId: CHAIN_ID,
      transport: RpcTransport.WSS,
      primary: {
        url: ORG_WSS,
        origin: RpcOrigin.ORG,
        configId: "cfg_main",
        addresses: [PUBLIC_ADDRESS],
      },
      fallback: undefined,
    });
  });

  it("does not hand out an organization endpoint whose host is not public", async () => {
    engine.route.mockResolvedValue(route(endpoint(RpcOrigin.ORG, ORG_WSS)));
    resolver.resolve.mockRejectedValue(new Error("blocked: private address"));

    const result = await attachTriggerRoutes([
      workflow("wf_1", { network: String(CHAIN_ID) }),
    ]);

    expect(result).toEqual([]);
  });

  it("drops a trigger the engine refuses to route", async () => {
    engine.route.mockRejectedValue(
      new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, CHAIN_ID)
    );
    const result = await attachTriggerRoutes([
      workflow("wf_1", { network: String(CHAIN_ID) }),
    ]);
    expect(result).toEqual([]);
  });

  it("does not route workflows without an organization or chain", async () => {
    const result = await attachTriggerRoutes([
      workflow("wf_1", { network: String(CHAIN_ID) }, null),
      workflow("wf_2", {}),
    ]);
    expect(result.map((entry) => entry.id)).toEqual(["wf_1", "wf_2"]);
    expect(engine.route).not.toHaveBeenCalled();
  });

  it("keeps a trigger whose chain KeeperHub cannot route, as before", async () => {
    engine.route.mockRejectedValue(
      new RpcRouteError(RpcRouteErrorCode.NO_SUBSCRIBE_ENDPOINT, CHAIN_ID)
    );
    const result = await attachTriggerRoutes([
      workflow("wf_1", { network: String(CHAIN_ID) }),
    ]);
    expect(result.map((entry) => entry.rpcRoute)).toEqual([undefined]);
  });

  it("rethrows anything that is not a route refusal", async () => {
    engine.route.mockRejectedValue(new Error("database down"));
    await expect(
      attachTriggerRoutes([workflow("wf_1", { network: String(CHAIN_ID) })])
    ).rejects.toThrow("database down");
  });
});
