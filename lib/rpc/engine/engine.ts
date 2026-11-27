import { AsyncLocalStorage } from "node:async_hooks";
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
import {
  noteRpcCall,
  noteRpcClient,
  noteRpcFailover,
} from "./step-attribution";
import { collectorFromSink } from "./telemetry/collector-adapter";
import { composeFailoverCallbacks } from "./telemetry/platform-collectors";
import { createPlatformSink } from "./telemetry/platform-sink";
import { createRouteSink, isPlatformOnlyRoute } from "./telemetry/route-sink";
import type { RpcOperationType, RpcTelemetrySink } from "./telemetry/sink";
import type { RpcUsageRecorder } from "./telemetry/usage";
import {
  PlatformRpcPurpose,
  type PrivateMempoolRequest,
  RpcChainType,
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  RpcRouteNotice,
  RpcRoutePosition,
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

/**
 * KeeperHub's own reads during a step, such as billing or a shared cache, are
 * not the step's traffic, just as they are not the organization's usage. A
 * run with no organization is the exception: KeeperHub serves the step.
 */
function scopedRequest(scope: RpcScope, request: RouteRequest): RouteRequest {
  const ownWork =
    scope.kind === RpcScopeKind.PLATFORM &&
    scope.purpose !== PlatformRpcPurpose.NO_ORGANIZATION;
  return ownWork ? { ...request, unattributed: true } : request;
}

type RpcClient<TManager> = {
  route: RpcRoute;
  manager: TManager;
  /** Where calls made outside the manager, like viem's, are reported. */
  telemetry: RpcTelemetrySink;
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

/** Marks the managers whose calls are left out of step attribution. */
const UNATTRIBUTED_CACHE_SUFFIX = ":unattributed";

/**
 * KeeperHub's endpoints for a chain, whichever organization the call is for:
 * one manager per set of URLs, so its failover state is learned once.
 */
function platformManagerKey(route: RpcRoute): string {
  const { primary, fallback } = route;
  return [
    "platform",
    route.chain.chainId,
    primary.role,
    primary.url.fingerprint,
    fallback?.role ?? "",
    fallback?.url.fingerprint ?? "",
  ].join(":");
}

function managerCacheKey(route: RpcRoute, request: RouteRequest): string {
  const { tuning } = request;
  const identity = isPlatformOnlyRoute(route)
    ? platformManagerKey(route)
    : route.key;
  const base = `${MANAGER_CACHE_PREFIX}${identity}`;
  const tuned = tuning
    ? `${base}:${tuning.maxRetries ?? ""}:${tuning.timeoutMs ?? ""}`
    : base;
  return request.unattributed ? `${tuned}${UNATTRIBUTED_CACHE_SUFFIX}` : tuned;
}

/**
 * Report each call attempt to the step making it. Managers are shared, but
 * a call runs in its caller's context, so the step that made it is noted.
 */
function attributedSink(
  sink: RpcTelemetrySink,
  route: RpcRoute
): RpcTelemetrySink {
  return {
    ...sink,
    attempt(position: RpcRoutePosition, operation: RpcOperationType): void {
      noteRpcCall(
        position === RpcRoutePosition.FALLBACK && route.fallback
          ? route.fallback
          : route.primary
      );
      sink.attempt(position, operation);
    },
    failover(): void {
      noteRpcFailover();
      sink.failover();
    },
  };
}

/** The telemetry of the client whose call is running. */
const callTelemetry = new AsyncLocalStorage<RpcTelemetrySink>();

/**
 * A shared manager's telemetry: each call reports to the client that made
 * it, so one manager can serve many organizations and keep their usage apart.
 */
function callerSink(outsideCall: RpcTelemetrySink): RpcTelemetrySink {
  const current = (): RpcTelemetrySink =>
    callTelemetry.getStore() ?? outsideCall;
  return {
    attempt: (position, operation) => current().attempt(position, operation),
    failure: (position, operation) => current().failure(position, operation),
    success: (position, operation) => current().success(position, operation),
    latency: (position, durationMs, operation) =>
      current().latency(position, durationMs, operation),
    errorType: (position, errorType, operation) =>
      current().errorType(position, errorType, operation),
    failover: () => current().failover(),
    recovery: () => current().recovery(),
    bothFailed: () => current().bothFailed(),
    event: (event) => current().event(event),
  };
}

type SharedManager = {
  executeWithFailover(...args: never[]): Promise<unknown>;
};

/** One view per shared manager and attribution, so a client's manager is stable. */
const sharedManagerViews = new WeakMap<object, Map<string, object>>();

/** The shared manager as one client sees it: its calls report to `sink`. */
function managerFor<TManager extends SharedManager>(
  manager: TManager,
  sink: RpcTelemetrySink,
  attribution: string
): TManager {
  const views = sharedManagerViews.get(manager) ?? new Map<string, object>();
  sharedManagerViews.set(manager, views);
  const existing = views.get(attribution);
  if (existing) {
    return existing as TManager;
  }
  const view = new Proxy(manager, {
    get(target, property): unknown {
      if (property === "getMetricsCollector" && property in target) {
        return () => collectorFromSink(sink);
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      // Every method runs in this client's context, including ones like
      // resolveActiveRpcUrl that call executeWithFailover on the manager.
      return (...args: unknown[]): unknown =>
        callTelemetry.run(sink, () => value.apply(target, args));
    },
  });
  views.set(attribution, view);
  return view;
}

/** Who a shared manager's calls are reported to, as a view key. */
function attributionOf(route: RpcRoute, request: RouteRequest): string {
  return `${route.organizationId ?? ""}:${request.unattributed ? "unattributed" : ""}`;
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
    resolved: RpcRoute,
    request: RouteRequest
  ): Promise<{
    sink: RpcTelemetrySink;
    managerSink: RpcTelemetrySink;
    onFailoverStateChange?: FailoverStateChangeCallback;
  }> {
    const collector = await collectors[family]();
    const platformSink = createPlatformSink({
      family,
      chainName: resolved.chain.name,
      collector,
    });
    const routeSink = createRouteSink(resolved, {
      platformSink,
      recorder: deps.usageRecorder,
    });
    const sink = request.unattributed
      ? routeSink
      : attributedSink(routeSink, resolved);
    // The per-chain "using fallback" gauge describes KeeperHub endpoints only.
    const platformOnly = isPlatformOnlyRoute(resolved);
    const onFailoverStateChange = platformOnly
      ? composeFailoverCallbacks(await deps.failoverCallback())
      : undefined;
    // A KeeperHub-only manager is shared across organizations, so it reports
    // to whichever client is calling; outside a call, to KeeperHub only.
    const managerSink = platformOnly ? callerSink(platformSink) : sink;
    return { sink, managerSink, onFailoverStateChange };
  }

  return {
    route,

    async evm(
      scope: RpcScope,
      chainId: number,
      requested: RouteRequest = {}
    ): Promise<EvmRpcClient> {
      const request = scopedRequest(scope, requested);
      const resolved = await routeFor(
        RpcChainType.EVM,
        scope,
        chainId,
        request
      );
      const { sink, managerSink, onFailoverStateChange } = await telemetryFor(
        RpcChainType.EVM,
        resolved,
        request
      );
      const manager = createRpcProviderManager({
        primaryRpcUrl: resolved.primary.url.reveal(),
        fallbackRpcUrl: resolved.fallback?.url.reveal(),
        chainName: resolved.chain.name,
        chainId: resolved.chain.chainId,
        primaryIsPrivateRelay:
          resolved.primary.role === RpcEndpointRole.PRIVATE,
        failureOwner: failureOwnerOf(resolved),
        telemetry: managerSink,
        onFailoverStateChange,
        maxRetries: request.tuning?.maxRetries,
        timeoutMs: request.tuning?.timeoutMs,
        cacheKey: managerCacheKey(resolved, request),
      });
      const client = {
        route: resolved,
        manager: isPlatformOnlyRoute(resolved)
          ? managerFor(manager, sink, attributionOf(resolved, request))
          : manager,
        telemetry: sink,
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
      requested: RouteRequest = {}
    ): Promise<SolanaRpcClient> {
      const request = scopedRequest(scope, requested);
      const resolved = await routeFor(
        RpcChainType.SOLANA,
        scope,
        chainId,
        request
      );
      const { sink, managerSink, onFailoverStateChange } = await telemetryFor(
        RpcChainType.SOLANA,
        resolved,
        request
      );
      const manager = createSolanaProviderManager({
        primaryRpcUrl: resolved.primary.url.reveal(),
        fallbackRpcUrl: resolved.fallback?.url.reveal(),
        chainName: resolved.chain.name,
        failureOwner: failureOwnerOf(resolved),
        telemetry: managerSink,
        onFailoverStateChange,
        maxRetries: request.tuning?.maxRetries,
        timeoutMs: request.tuning?.timeoutMs,
        cacheKey: managerCacheKey(resolved, request),
      });
      const client = {
        route: resolved,
        manager: isPlatformOnlyRoute(resolved)
          ? managerFor(manager, sink, attributionOf(resolved, request))
          : manager,
        telemetry: sink,
        activeEndpoint: activeEndpointOf(resolved, manager),
      };
      if (!request.unattributed) {
        noteRpcClient(client);
      }
      return client;
    },
  };
}
