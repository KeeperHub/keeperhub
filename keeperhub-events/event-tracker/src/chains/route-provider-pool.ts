import type { LookupFunction } from "node:net";
import { pinnedLookup } from "./pinned-lookup";
import {
  ChainProviderManager,
  type ChainProviderManagerOptions,
  type ProviderUsageEvent,
  createWebSocketProvider,
  silentLogger,
} from "./provider-manager";
import {
  RpcOrigin,
  type RpcRoute,
  type RpcRouteEndpoint,
  type RpcUsageCounter,
} from "./rpc-route";

/** The fields a usage bucket is attributed to. */
export interface RpcUsageAttribution {
  organizationId: string;
  configId: string | null;
  origin: RpcRouteEndpoint["origin"];
  chainId: number;
  transport: RpcRoute["transport"];
}

export interface RpcUsageRecorder {
  record(
    attribution: RpcUsageAttribution,
    counter: RpcUsageCounter,
    count: number,
  ): void;
}

export interface RouteLease {
  readonly manager: ChainProviderManager;
  /** True once the route's connection failed permanently and was torn down. */
  readonly failed: boolean;
  release(): void;
}

export type RouteManagerFactory = (
  opts: ChainProviderManagerOptions,
) => ChainProviderManager;

export interface RouteProviderPoolOptions {
  /** Base options for every manager the pool creates, such as a test factory. */
  managerOptions?: Omit<
    ChainProviderManagerOptions,
    "logger" | "onPermanentFailure" | "onUsage"
  >;
  createManager?: RouteManagerFactory;
  usage?: RpcUsageRecorder;
}

interface PoolEntry {
  route: RpcRoute;
  manager: ChainProviderManager;
  refs: number;
  failed: boolean;
}

function endpointFor(route: RpcRoute, url: string): RpcRouteEndpoint | null {
  if (url === route.primary.url) {
    return route.primary;
  }
  if (route.fallback && url === route.fallback.url) {
    return route.fallback;
  }
  return null;
}

/**
 * Pinned to the vetted addresses for an organization endpoint, ordinary DNS
 * for a KeeperHub one, and no address at all for a URL the route does not
 * hold, so an unknown URL can never be dialled unchecked.
 */
function lookupFor(route: RpcRoute, url: string): LookupFunction | undefined {
  const endpoint = endpointFor(route, url);
  if (!endpoint) {
    return pinnedLookup([]);
  }
  if (endpoint.origin !== RpcOrigin.ORG) {
    return undefined;
  }
  return pinnedLookup(endpoint.addresses ?? []);
}

function sameEndpoints(a: RpcRoute, b: RpcRoute): boolean {
  return a.primary.url === b.primary.url && a.fallback?.url === b.fallback?.url;
}

/**
 * One ChainProviderManager per organization route key, shared by every
 * workflow on that route. These managers log nothing, stay out of /healthz,
 * and a permanent failure tears down only the route it happened on.
 */
export class RouteProviderPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly teardowns = new Set<Promise<void>>();
  private readonly opts: RouteProviderPoolOptions;

  constructor(opts: RouteProviderPoolOptions = {}) {
    this.opts = opts;
  }

  acquire(route: RpcRoute): RouteLease {
    const entry = this.entries.get(route.key) ?? this.createEntry(route);
    // The latest vetted addresses are the ones the next connection uses, but
    // only for the endpoints the manager was built with.
    if (sameEndpoints(entry.route, route)) {
      entry.route = route;
    }
    entry.refs += 1;
    let released = false;
    return {
      manager: entry.manager,
      get failed(): boolean {
        return entry.failed;
      },
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.releaseEntry(route.key, entry);
      },
    };
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  size(): number {
    return this.entries.size;
  }

  async destroyAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      this.teardown(entry.manager);
    }
    this.entries.clear();
    await Promise.all([...this.teardowns]);
  }

  private createEntry(route: RpcRoute): PoolEntry {
    const entry = { route, refs: 0, failed: false } as PoolEntry;
    const create =
      this.opts.createManager ??
      ((opts: ChainProviderManagerOptions) => new ChainProviderManager(opts));
    entry.manager = create({
      factory: (url) =>
        createWebSocketProvider(url, lookupFor(entry.route, url)),
      ...this.opts.managerOptions,
      logger: silentLogger,
      onPermanentFailure: () => this.fail(route.key, entry),
      onUsage: (event) => this.recordUsage(route, event),
    });
    this.entries.set(route.key, entry);
    return entry;
  }

  private releaseEntry(key: string, entry: PoolEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0 || this.entries.get(key) !== entry) {
      return;
    }
    this.entries.delete(key);
    this.teardown(entry.manager);
  }

  private fail(key: string, entry: PoolEntry): void {
    entry.failed = true;
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
    this.teardown(entry.manager);
  }

  private teardown(manager: ChainProviderManager): void {
    const done = manager
      .destroy()
      .catch(() => undefined)
      .finally(() => {
        this.teardowns.delete(done);
      });
    this.teardowns.add(done);
  }

  private recordUsage(route: RpcRoute, event: ProviderUsageEvent): void {
    const endpoint = endpointFor(route, event.url);
    if (!(endpoint && this.opts.usage)) {
      return;
    }
    this.opts.usage.record(
      {
        organizationId: route.organizationId,
        configId: endpoint.configId,
        origin: endpoint.origin,
        chainId: route.chainId,
        transport: route.transport,
      },
      event.counter,
      event.count,
    );
  }
}
