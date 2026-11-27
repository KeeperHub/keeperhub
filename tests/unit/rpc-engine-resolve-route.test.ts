import { describe, expect, it } from "vitest";
import {
  type ResolveRouteInput,
  resolveRoute,
} from "@/lib/rpc/engine/resolve-route";
import { RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import {
  type OrgRpcConfig,
  type OrgRpcState,
  type PlatformEndpoints,
  PlatformRpcPurpose,
  type RpcChain,
  RpcChainType,
  RpcEndpointRole,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  RpcRouteNotice,
  type RpcScope,
  RpcScopeKind,
  RpcSelectionMode,
  RpcTransport,
} from "@/lib/rpc/engine/types";

const CHAIN_ID = 1;
const ORG = "org_1";

const evmChain: RpcChain = {
  chainId: CHAIN_ID,
  name: "Ethereum Mainnet",
  chainType: RpcChainType.EVM,
  isEnabled: true,
};

const solanaChain: RpcChain = {
  chainId: 101,
  name: "Solana",
  chainType: RpcChainType.SOLANA,
  isEnabled: true,
};

const url = (value: string): SecretUrl => SecretUrl.parse(value);

const platform: PlatformEndpoints = {
  httpPrimary: url("https://kh-primary.example.com/key"),
  httpFallback: url("https://kh-fallback.example.com/key"),
  wssPrimary: url("wss://kh-primary.example.com/key"),
  wssFallback: url("wss://kh-fallback.example.com/key"),
  privateTx: url("https://kh-relay.example.com"),
};

function config(overrides: Partial<OrgRpcConfig> = {}): OrgRpcConfig {
  return {
    id: "cfg_main",
    name: "Main",
    chainId: CHAIN_ID,
    enabled: true,
    isDefault: true,
    httpPrimary: url("https://org-primary.example.com/key"),
    httpFallback: url("https://org-fallback.example.com/key"),
    wssPrimary: url("wss://org-primary.example.com/key"),
    wssFallback: url("wss://org-fallback.example.com/key"),
    ...overrides,
  };
}

function orgState(
  configs: OrgRpcConfig[] = [],
  ownRpcOnly = false
): OrgRpcState {
  return { policy: { ownRpcOnly }, configs };
}

const auto: RpcScope = {
  kind: RpcScopeKind.ORG,
  organizationId: ORG,
  selection: { mode: RpcSelectionMode.AUTO },
};

function input(overrides: Partial<ResolveRouteInput> = {}): ResolveRouteInput {
  return {
    chainId: CHAIN_ID,
    scope: auto,
    chain: evmChain,
    platform,
    org: orgState(),
    purpose: RpcPurpose.READ,
    ...overrides,
  };
}

function ok(result: ReturnType<typeof resolveRoute>): RpcRoute {
  if (!result.ok) {
    throw new Error(`expected a route, got ${result.error.code}`);
  }
  return result.route;
}

function errorCode(result: ReturnType<typeof resolveRoute>): string {
  if (result.ok) {
    throw new Error("expected an error, got a route");
  }
  return result.error.code;
}

function hosts(route: RpcRoute): [string, string | undefined] {
  return [route.primary.url.hostname, route.fallback?.url.hostname];
}

describe("resolveRoute", () => {
  describe("chain availability", () => {
    it("fails when the chain is unknown or disabled", () => {
      expect(errorCode(resolveRoute(input({ chain: null })))).toBe(
        RpcRouteErrorCode.CHAIN_UNAVAILABLE
      );
      expect(
        errorCode(
          resolveRoute(input({ chain: { ...evmChain, isEnabled: false } }))
        )
      ).toBe(RpcRouteErrorCode.CHAIN_UNAVAILABLE);
      expect(errorCode(resolveRoute(input({ platform: null })))).toBe(
        RpcRouteErrorCode.CHAIN_UNAVAILABLE
      );
    });
  });

  describe("platform scope", () => {
    const scope: RpcScope = {
      kind: RpcScopeKind.PLATFORM,
      purpose: PlatformRpcPurpose.BILLING,
    };

    it("uses KeeperHub endpoints and is not attributed to an organization", () => {
      const route = ok(resolveRoute(input({ scope })));
      expect(hosts(route)).toEqual([
        "kh-primary.example.com",
        "kh-fallback.example.com",
      ]);
      expect(route.organizationId).toBeNull();
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
    });

    it("ignores organization configs and policy entirely", () => {
      const route = ok(
        resolveRoute(input({ scope, org: orgState([config()], true) }))
      );
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
      expect(route.ownRpcOnly).toBe(false);
    });
  });

  describe("auto selection", () => {
    it("uses KeeperHub when the organization has no default for the chain", () => {
      const route = ok(resolveRoute(input()));
      expect(hosts(route)).toEqual([
        "kh-primary.example.com",
        "kh-fallback.example.com",
      ]);
      expect(route.organizationId).toBe(ORG);
    });

    it("uses the organization default for the chain", () => {
      const route = ok(resolveRoute(input({ org: orgState([config()]) })));
      expect(hosts(route)).toEqual([
        "org-primary.example.com",
        "org-fallback.example.com",
      ]);
      expect(route.primary).toMatchObject({
        origin: RpcOrigin.ORG,
        role: RpcEndpointRole.PRIMARY,
        configId: "cfg_main",
        configName: "Main",
      });
    });

    it("skips defaults that are disabled or for another chain", () => {
      const route = ok(
        resolveRoute(
          input({
            org: orgState([
              config({ enabled: false }),
              config({ id: "cfg_base", chainId: 8453 }),
            ]),
          })
        )
      );
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
    });

    it("skips configs that are not the default", () => {
      const route = ok(
        resolveRoute(input({ org: orgState([config({ isDefault: false })]) }))
      );
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
    });

    it("fills a missing org fallback with the KeeperHub primary", () => {
      const route = ok(
        resolveRoute(
          input({ org: orgState([config({ httpFallback: undefined })]) })
        )
      );
      expect(route.primary.origin).toBe(RpcOrigin.ORG);
      expect(route.fallback).toMatchObject({ origin: RpcOrigin.PLATFORM });
      expect(route.fallback?.url.hostname).toBe("kh-primary.example.com");
    });
  });

  describe("own RPC only", () => {
    it("never fills the fallback slot from KeeperHub", () => {
      const route = ok(
        resolveRoute(
          input({ org: orgState([config({ httpFallback: undefined })], true) })
        )
      );
      expect(route.primary.origin).toBe(RpcOrigin.ORG);
      expect(route.fallback).toBeUndefined();
      expect(route.ownRpcOnly).toBe(true);
    });

    it("keeps the organization's own fallback", () => {
      const route = ok(
        resolveRoute(input({ org: orgState([config()], true) }))
      );
      expect(hosts(route)).toEqual([
        "org-primary.example.com",
        "org-fallback.example.com",
      ]);
    });

    it("refuses a chain the organization has not covered", () => {
      expect(errorCode(resolveRoute(input({ org: orgState([], true) })))).toBe(
        RpcRouteErrorCode.NOT_COVERED
      );
    });

    it("refuses an explicit KeeperHub selection", () => {
      const scope: RpcScope = {
        ...auto,
        selection: { mode: RpcSelectionMode.PLATFORM },
      };
      expect(
        errorCode(
          resolveRoute(input({ scope, org: orgState([config()], true) }))
        )
      ).toBe(RpcRouteErrorCode.PLATFORM_FORBIDDEN);
    });
  });

  describe("explicit selections", () => {
    it("uses KeeperHub when the node asks for it", () => {
      const scope: RpcScope = {
        ...auto,
        selection: { mode: RpcSelectionMode.PLATFORM },
      };
      const route = ok(
        resolveRoute(input({ scope, org: orgState([config()]) }))
      );
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
      expect(route.organizationId).toBe(ORG);
    });

    it("uses a pinned config even when it is not the default", () => {
      const archive = config({
        id: "cfg_archive",
        name: "Archive",
        isDefault: false,
        httpPrimary: url("https://archive.example.com/key"),
        httpFallback: undefined,
      });
      const scope: RpcScope = {
        ...auto,
        selection: { mode: RpcSelectionMode.CONFIG, configId: "cfg_archive" },
      };
      const route = ok(
        resolveRoute(input({ scope, org: orgState([config(), archive]) }))
      );
      expect(route.primary.url.hostname).toBe("archive.example.com");
      expect(route.primary.configId).toBe("cfg_archive");
    });

    it("rejects a pinned config that is missing, disabled or for another chain", () => {
      const pin = (configId: string): RpcScope => ({
        ...auto,
        selection: { mode: RpcSelectionMode.CONFIG, configId },
      });
      const configs = [
        config({ id: "cfg_off", enabled: false }),
        config({ id: "cfg_base", chainId: 8453 }),
      ];
      expect(
        errorCode(
          resolveRoute(
            input({ scope: pin("cfg_gone"), org: orgState(configs) })
          )
        )
      ).toBe(RpcRouteErrorCode.CONFIG_NOT_FOUND);
      expect(
        errorCode(
          resolveRoute(input({ scope: pin("cfg_off"), org: orgState(configs) }))
        )
      ).toBe(RpcRouteErrorCode.CONFIG_DISABLED);
      expect(
        errorCode(
          resolveRoute(
            input({ scope: pin("cfg_base"), org: orgState(configs) })
          )
        )
      ).toBe(RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH);
    });
  });

  describe("subscriptions", () => {
    it("uses WebSocket endpoints on EVM chains", () => {
      const route = ok(
        resolveRoute(
          input({ purpose: RpcPurpose.SUBSCRIBE, org: orgState([config()]) })
        )
      );
      expect(route.transport).toBe(RpcTransport.WSS);
      expect(hosts(route)).toEqual([
        "org-primary.example.com",
        "org-fallback.example.com",
      ]);
    });

    it("falls back to the KeeperHub WebSocket when the config has none", () => {
      const route = ok(
        resolveRoute(
          input({
            purpose: RpcPurpose.SUBSCRIBE,
            org: orgState([
              config({ wssPrimary: undefined, wssFallback: undefined }),
            ]),
          })
        )
      );
      expect(route.primary.origin).toBe(RpcOrigin.PLATFORM);
      expect(route.transport).toBe(RpcTransport.WSS);
    });

    it("refuses a config without WebSocket under own RPC only", () => {
      expect(
        errorCode(
          resolveRoute(
            input({
              purpose: RpcPurpose.SUBSCRIBE,
              org: orgState(
                [config({ wssPrimary: undefined, wssFallback: undefined })],
                true
              ),
            })
          )
        )
      ).toBe(RpcRouteErrorCode.NOT_COVERED);
    });

    it("fails when KeeperHub has no WebSocket for the chain", () => {
      expect(
        errorCode(
          resolveRoute(
            input({
              purpose: RpcPurpose.SUBSCRIBE,
              platform: { httpPrimary: platform.httpPrimary },
            })
          )
        )
      ).toBe(RpcRouteErrorCode.NO_SUBSCRIBE_ENDPOINT);
    });

    it("subscribes over HTTP on Solana", () => {
      const route = ok(
        resolveRoute(
          input({
            chainId: 101,
            chain: solanaChain,
            purpose: RpcPurpose.SUBSCRIBE,
            org: orgState([config({ chainId: 101 })]),
          })
        )
      );
      expect(route.transport).toBe(RpcTransport.HTTP);
      expect(route.primary.url.hostname).toBe("org-primary.example.com");
    });
  });

  describe("private mempool", () => {
    it("puts the KeeperHub relay first and keeps the public fallback when not strict", () => {
      const route = ok(
        resolveRoute(
          input({
            purpose: RpcPurpose.WRITE,
            privateMempool: { strict: false },
          })
        )
      );
      expect(route.primary).toMatchObject({
        origin: RpcOrigin.PLATFORM,
        role: RpcEndpointRole.PRIVATE,
      });
      expect(route.fallback?.url.hostname).toBe("kh-primary.example.com");
    });

    it("drops the public fallback when strict", () => {
      const route = ok(
        resolveRoute(
          input({ purpose: RpcPurpose.WRITE, privateMempool: { strict: true } })
        )
      );
      expect(route.primary.role).toBe(RpcEndpointRole.PRIVATE);
      expect(route.fallback).toBeUndefined();
    });

    it("prefers the organization's own private URL", () => {
      const route = ok(
        resolveRoute(
          input({
            purpose: RpcPurpose.WRITE,
            privateMempool: { strict: false },
            org: orgState([
              config({ privateTx: url("https://org-relay.example.com/key") }),
            ]),
          })
        )
      );
      expect(route.primary).toMatchObject({
        origin: RpcOrigin.ORG,
        role: RpcEndpointRole.PRIVATE,
      });
      expect(route.fallback?.url.hostname).toBe("org-primary.example.com");
    });

    it("uses the KeeperHub relay for an org config without one when allowed", () => {
      const route = ok(
        resolveRoute(
          input({
            purpose: RpcPurpose.WRITE,
            privateMempool: { strict: false },
            org: orgState([config()]),
          })
        )
      );
      expect(route.primary).toMatchObject({
        origin: RpcOrigin.PLATFORM,
        role: RpcEndpointRole.PRIVATE,
      });
      expect(route.fallback).toMatchObject({ origin: RpcOrigin.ORG });
    });

    it("refuses the KeeperHub relay under own RPC only", () => {
      expect(
        errorCode(
          resolveRoute(
            input({
              purpose: RpcPurpose.WRITE,
              privateMempool: { strict: true },
              org: orgState([config()], true),
            })
          )
        )
      ).toBe(RpcRouteErrorCode.NO_PRIVATE_URL);
    });

    it("proceeds publicly with a notice when the chain has no relay", () => {
      const route = ok(
        resolveRoute(
          input({
            purpose: RpcPurpose.WRITE,
            privateMempool: { strict: true },
            platform: { ...platform, privateTx: undefined },
          })
        )
      );
      expect(route.primary.role).toBe(RpcEndpointRole.PRIMARY);
      expect(route.notices).toEqual([
        RpcRouteNotice.PRIVATE_MEMPOOL_UNSUPPORTED,
      ]);
    });

    it("ignores a private request on reads", () => {
      const route = ok(
        resolveRoute(
          input({ purpose: RpcPurpose.READ, privateMempool: { strict: true } })
        )
      );
      expect(route.primary.role).toBe(RpcEndpointRole.PRIMARY);
      expect(route.notices).toEqual([]);
    });
  });

  describe("route key", () => {
    it("is stable for the same inputs", () => {
      expect(ok(resolveRoute(input())).key).toBe(ok(resolveRoute(input())).key);
    });

    it("differs between organizations on the same endpoints", () => {
      const other: RpcScope = { ...auto, organizationId: "org_2" };
      expect(ok(resolveRoute(input())).key).not.toBe(
        ok(resolveRoute(input({ scope: other }))).key
      );
    });

    it("differs between platform and organization scopes on the same endpoints", () => {
      const scope: RpcScope = {
        kind: RpcScopeKind.PLATFORM,
        purpose: PlatformRpcPurpose.BILLING,
      };
      expect(ok(resolveRoute(input())).key).not.toBe(
        ok(resolveRoute(input({ scope }))).key
      );
    });

    it("never contains an endpoint URL", () => {
      const route = ok(resolveRoute(input({ org: orgState([config()]) })));
      expect(route.key).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
