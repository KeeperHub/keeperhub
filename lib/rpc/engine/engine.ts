import { logWarn } from "@/lib/logging";
import {
  createRpcProviderManager,
  type FailoverStateChangeCallback,
  type RpcMetricsCollector,
  type RpcProviderManager,
} from "../providers";
import {
  createSolanaProviderManager,
  type SolanaProviderManager,
  type SolanaRpcMetricsCollector,
} from "../providers/solana";
import { resolveRoute } from "./resolve-route";
import { RpcRouteError, RpcRouteErrorCode } from "./route-error";
import { EMPTY_ORG_RPC_STATE, type OrgRpcSource } from "./sources/org-source";
import type { PlatformRpcSource } from "./sources/platform-source";
import { noteRpcClient } from "./step-attribution";
import { composeFailoverCallbacks } from "./telemetry/platform-collectors";
import { createPlatformSink } from "./telemetry/platform-sink";
import { createRouteSink, isPlatformOnlyRoute } from "./telemetry/route-sink";
import type { RpcTelemetrySink } from "./telemetry/sink";
import type { RpcUsageRecorder } from "./telemetry/usage";
import {
  type PrivateMempoolRequest,
  RpcChainType,
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  RpcRouteNotice,
  type RpcScope,
  RpcScopeKind,
} from "./types";

export type RpcEngineDeps = {
  platformSource: PlatformRpcSource;
  orgSource: OrgRpcSource;
  usageRecorder: RpcUsageRecorder;
  evmCollector: () => Promise<RpcMetricsCollector>;
  solanaCollector: () => Promise<SolanaRpcMetricsCollector>;
  failoverCallback: () => Promise<FailoverStateChangeCallback>;
};

/** Retry budget for callers that must not use the shared defaults. */
export type RpcClientTuning = {
  maxRetries?: number;
  timeoutMs?: number;
};

export type RouteRequest = {
  purpose?: RpcPurpose;
  privateMempool?: PrivateMempoolRequest;
  /** Gets its own cached manager, so the shared one keeps its defaults. */
  tuning?: RpcClientTuning;
  /** A check on the step's outcome, not the step's own call; left out of its attribution. */
  unattributed?: boolean;
};

type RpcClient<TManager> = {
  route: RpcRoute;
  manager: TManager;
  /** The endpoint currently serving calls, for per-step attribution. */
  activeEndpoint(): RpcEndpoint;
};

export type EvmRpcClient = RpcClient<RpcProviderManager>;
export type SolanaRpcClient = RpcClient<SolanaProviderManager>;

export type RpcEngine = {
  /** Resolve which endpoints serve a call. Throws RpcRouteError. */
  route(
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<RpcRoute>;
  /** A failover-managed EVM client for the resolved route. */
  evm(
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<EvmRpcClient>;
  /** A failover-managed Solana client for the resolved route. */
  solana(
    scope: RpcScope,
    chainId: number,
    request?: RouteRequest
  ): Promise<SolanaRpcClient>;
};

function activeEndpointOf(
  route: RpcRoute,
  manager: { isCurrentlyUsingFallback(): boolean }
): () => RpcEndpoint {
  return () =>
    manager.isCurrentlyUsingFallback() && route.fallback
      ? route.fallback
      : route.primary;
}

/** A route with any organization endpoint fails as that organization's. */
function failureOwnerOf(route: RpcRoute): RpcOrigin {
  return isPlatformOnlyRoute(route) ? RpcOrigin.PLATFORM : RpcOrigin.ORG;
}

/** Namespaces engine-built managers in the provider caches. */
const MANAGER_CACHE_PREFIX = "route:";

function managerCacheKey(route: RpcRoute, tuning?: RpcClientTuning): string {
  const base = `${MANAGER_CACHE_PREFIX}${route.key}`;
  return tuning
    ? `${base}:${tuning.maxRetries ?? ""}:${tuning.timeoutMs ?? ""}`
    : base;
}

export function createRpcEngine(deps: RpcEngineDeps): RpcEngine {
  const collectors: Record<
    RpcChainType,
    () => Promise<RpcMetricsCollector | SolanaRpcMetricsCollector>
  > = {
    [RpcChainType.EVM]: deps.evmCollector,
    [RpcChainType.SOLANA]: deps.solanaCollector,
  };

  async function route(
    scope: RpcScope,
    chainId: number,
    request: RouteRequest = {}
  ): Promise<RpcRoute> {
    const [record, org] = await Promise.all([
      deps.platformSource.load(chainId),
      scope.kind === RpcScopeKind.ORG
        ? deps.orgSource.load(scope.organizationId, chainId)
        : Promise.resolve(EMPTY_ORG_RPC_STATE),
    ]);
    const result = resolveRoute({
      chainId,
      scope,
      chain: record?.chain ?? null,
      platform: record?.endpoints ?? null,
      org,
      purpose: request.purpose ?? RpcPurpose.READ,
      privateMempool: request.privateMempool,
    });
    if (!result.ok) {
      throw result.error;
    }
    if (
      result.route.notices.includes(RpcRouteNotice.PRIVATE_MEMPOOL_UNSUPPORTED)
    ) {
      logWarn(
        `[rpc-config] Private mempool requested for chain ${chainId} ` +
          "but chain does not support it; proceeding with public mempool"
      );
    }
    return result.route;
  }

  async function routeFor(
    family: RpcChainType,
    scope: RpcScope,
    chainId: number,
    request: RouteRequest
  ): Promise<RpcRoute> {
    const resolved = await route(scope, chainId, request);
    if (resolved.chain.chainType !== family) {
      throw new RpcRouteError(RpcRouteErrorCode.WRONG_CHAIN_FAMILY, chainId);
    }
    return resolved;
  }

  async function telemetryFor(
    family: RpcChainType,
    resolved: RpcRoute
  ): Promise<{
    sink: RpcTelemetrySink;
    onFailoverStateChange?: FailoverStateChangeCallback;
  }> {
    const collector = await collectors[family]();
    const platformSink = createPlatformSink({
      family,
      chainName: resolved.chain.name,
      collector,
    });
    const sink = createRouteSink(resolved, {
      platformSink,
      recorder: deps.usageRecorder,
    });
    // The per-chain "using fallback" gauge describes KeeperHub endpoints only.
    const onFailoverStateChange = isPlatformOnlyRoute(resolved)
      ? composeFailoverCallbacks(await deps.failoverCallback())
      : undefined;
    return { sink, onFailoverStateChange };
  }

  return {
    route,

    async evm(
      scope: RpcScope,
      chainId: number,
      request: RouteRequest = {}
    ): Promise<EvmRpcClient> {
      const resolved = await routeFor(
        RpcChainType.EVM,
        scope,
        chainId,
        request
      );
      const { sink, onFailoverStateChange } = await telemetryFor(
        RpcChainType.EVM,
        resolved
      );
      const manager = createRpcProviderManager({
        primaryRpcUrl: resolved.primary.url.reveal(),
        fallbackRpcUrl: resolved.fallback?.url.reveal(),
        chainName: resolved.chain.name,
        chainId: resolved.chain.chainId,
        primaryIsPrivateRelay:
          resolved.primary.role === RpcEndpointRole.PRIVATE,
        failureOwner: failureOwnerOf(resolved),
        telemetry: sink,
        onFailoverStateChange,
        maxRetries: request.tuning?.maxRetries,
        timeoutMs: request.tuning?.timeoutMs,
        cacheKey: managerCacheKey(resolved, request.tuning),
      });
      const client = {
        route: resolved,
        manager,
        activeEndpoint: activeEndpointOf(resolved, manager),
      };
      if (!request.unattributed) {
        noteRpcClient(client);
      }
      return client;
    },

    async solana(
      scope: RpcScope,
      chainId: number,
      request: RouteRequest = {}
    ): Promise<SolanaRpcClient> {
      const resolved = await routeFor(
        RpcChainType.SOLANA,
        scope,
        chainId,
        request
      );
      const { sink, onFailoverStateChange } = await telemetryFor(
        RpcChainType.SOLANA,
        resolved
      );
      const manager = createSolanaProviderManager({
        primaryRpcUrl: resolved.primary.url.reveal(),
        fallbackRpcUrl: resolved.fallback?.url.reveal(),
        chainName: resolved.chain.name,
        failureOwner: failureOwnerOf(resolved),
        telemetry: sink,
        onFailoverStateChange,
        maxRetries: request.tuning?.maxRetries,
        timeoutMs: request.tuning?.timeoutMs,
        cacheKey: managerCacheKey(resolved, request.tuning),
      });
      const client = {
        route: resolved,
        manager,
        activeEndpoint: activeEndpointOf(resolved, manager),
      };
      if (!request.unattributed) {
        noteRpcClient(client);
      }
      return client;
    },
  };
}
