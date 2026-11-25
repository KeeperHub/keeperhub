import type { RpcOrigin, RpcTransport } from "../types";

/** One row of an organization's RPC usage: which endpoint, on which chain. */
export type RpcUsageKey = {
  organizationId: string;
  configId: string | null;
  origin: RpcOrigin;
  chainId: number;
  transport: RpcTransport;
};

export type RpcUsageCounters = {
  requests: number;
  errors: number;
  timeouts: number;
  rateLimited: number;
  failovers: number;
  latencyMsSum: number;
  latencyMsMax: number;
  wsConnects: number;
  wsReconnects: number;
  eventsReceived: number;
};

export type RpcUsageDelta = Partial<RpcUsageCounters>;

export type RpcUsageBucket = RpcUsageKey & {
  /** Start of the UTC hour the counts belong to. */
  hour: Date;
  counters: RpcUsageCounters;
};

/** Where organization usage goes. Never Prometheus, Loki or Sentry. */
export type RpcUsageRecorder = {
  record(key: RpcUsageKey, delta: RpcUsageDelta): void;
};

export const noopUsageRecorder: RpcUsageRecorder = {
  record: (): void => {
    /* noop */
  },
};

const HOUR_MS = 3_600_000;

function emptyCounters(): RpcUsageCounters {
  return {
    requests: 0,
    errors: 0,
    timeouts: 0,
    rateLimited: 0,
    failovers: 0,
    latencyMsSum: 0,
    latencyMsMax: 0,
    wsConnects: 0,
    wsReconnects: 0,
    eventsReceived: 0,
  };
}

function bucketId(key: RpcUsageKey, hourMs: number): string {
  return JSON.stringify([
    key.organizationId,
    key.configId,
    key.origin,
    key.chainId,
    key.transport,
    hourMs,
  ]);
}

function addInto(target: RpcUsageCounters, delta: RpcUsageDelta): void {
  target.requests += delta.requests ?? 0;
  target.errors += delta.errors ?? 0;
  target.timeouts += delta.timeouts ?? 0;
  target.rateLimited += delta.rateLimited ?? 0;
  target.failovers += delta.failovers ?? 0;
  target.latencyMsSum += delta.latencyMsSum ?? 0;
  target.latencyMsMax = Math.max(target.latencyMsMax, delta.latencyMsMax ?? 0);
  target.wsConnects += delta.wsConnects ?? 0;
  target.wsReconnects += delta.wsReconnects ?? 0;
  target.eventsReceived += delta.eventsReceived ?? 0;
}

/**
 * In-memory hourly buckets of organization usage. A persistence layer drains
 * it on an interval and at process or execution end, and adds the buckets to
 * stored rows, so draining twice never double counts.
 */
export class RpcUsageAccumulator implements RpcUsageRecorder {
  readonly #buckets = new Map<string, RpcUsageBucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(key: RpcUsageKey, delta: RpcUsageDelta): void {
    const hourMs = Math.floor(this.#now() / HOUR_MS) * HOUR_MS;
    const id = bucketId(key, hourMs);
    let bucket = this.#buckets.get(id);
    if (!bucket) {
      bucket = { ...key, hour: new Date(hourMs), counters: emptyCounters() };
      this.#buckets.set(id, bucket);
    }
    addInto(bucket.counters, delta);
  }

  get size(): number {
    return this.#buckets.size;
  }

  /** Take every bucket recorded so far and start empty. */
  drain(): RpcUsageBucket[] {
    const drained = [...this.#buckets.values()];
    this.#buckets.clear();
    return drained;
  }

  /** Put buckets back after a failed write so they go out with the next drain. */
  restore(buckets: readonly RpcUsageBucket[]): void {
    for (const bucket of buckets) {
      const id = bucketId(bucket, bucket.hour.getTime());
      const existing = this.#buckets.get(id);
      if (existing) {
        addInto(existing.counters, bucket.counters);
      } else {
        this.#buckets.set(id, { ...bucket, counters: { ...bucket.counters } });
      }
    }
  }
}
