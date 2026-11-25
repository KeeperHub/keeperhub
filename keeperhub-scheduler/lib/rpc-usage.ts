/** Hourly usage of organization RPC endpoints, reported to the app without urls. */

import { apiRequestOnce } from "./http-client.js";
import {
  RPC_USAGE_FLUSH_INTERVAL_MS,
  RPC_USAGE_INGEST_PATH,
  RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
  RPC_USAGE_MAX_RETAINED_BUCKETS,
  type RpcOrigin,
  type RpcTransport,
  type RpcUsageCounter,
} from "./rpc-route.js";

const HOUR_MS = 3_600_000;

/** The endpoint usage is attributed to. */
export type RpcUsageSource = {
  organizationId: string;
  configId: string | null;
  origin: RpcOrigin;
  chainId: number;
  transport: RpcTransport;
};

export type RpcUsageCounters = Partial<Record<RpcUsageCounter, number>>;

export type RpcUsageBucket = RpcUsageSource & {
  hour: string;
  counters: RpcUsageCounters;
};

export type RpcUsageSend = (body: string) => Promise<void>;

type RpcUsageReporterOptions = {
  send?: RpcUsageSend;
  now?: () => number;
  maxRetainedBuckets?: number;
};

async function postUsage(body: string): Promise<void> {
  await apiRequestOnce(RPC_USAGE_INGEST_PATH, { method: "POST", body });
}

function hourStart(atMs: number): string {
  return new Date(Math.floor(atMs / HOUR_MS) * HOUR_MS).toISOString();
}

function bucketKey(source: RpcUsageSource, hour: string): string {
  return JSON.stringify([
    source.organizationId,
    source.configId,
    source.origin,
    source.chainId,
    source.transport,
    hour,
  ]);
}

export class RpcUsageReporter {
  private buckets: Map<string, RpcUsageBucket> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly send: RpcUsageSend;
  private readonly now: () => number;
  private readonly maxRetainedBuckets: number;

  constructor(options: RpcUsageReporterOptions = {}) {
    this.send = options.send ?? postUsage;
    this.now = options.now ?? Date.now;
    this.maxRetainedBuckets =
      options.maxRetainedBuckets ?? RPC_USAGE_MAX_RETAINED_BUCKETS;
  }

  record(source: RpcUsageSource, counter: RpcUsageCounter, count = 1): void {
    const hour = hourStart(this.now());
    const bucket: RpcUsageBucket = {
      organizationId: source.organizationId,
      configId: source.configId,
      origin: source.origin,
      chainId: source.chainId,
      transport: source.transport,
      hour,
      counters: { [counter]: count },
    };
    this.add(bucket, bucketKey(source, hour));
    this.trim();
  }

  pendingBuckets(): RpcUsageBucket[] {
    return [...this.buckets.values()];
  }

  start(intervalMs: number = RPC_USAGE_FLUSH_INTERVAL_MS): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.flush().catch(() => {
        // flush keeps unsent counts and logs the failure itself
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
    }
    if (this.buckets.size === 0) {
      return;
    }
    this.flushing = this.sendAll();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async sendAll(): Promise<void> {
    const pending = [...this.buckets.values()];
    this.buckets = new Map();
    for (
      let offset = 0;
      offset < pending.length;
      offset += RPC_USAGE_MAX_BUCKETS_PER_REQUEST
    ) {
      const batch = pending.slice(
        offset,
        offset + RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
      );
      try {
        await this.send(JSON.stringify({ buckets: batch }));
      } catch (error) {
        this.restore(pending.slice(offset));
        console.warn(
          `[RpcUsage] Failed to report ${pending.length - offset} usage bucket(s), keeping them for the next attempt: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
  }

  private restore(unsent: RpcUsageBucket[]): void {
    for (const bucket of unsent) {
      this.add(bucket, bucketKey(bucket, bucket.hour));
    }
    this.trim();
  }

  private add(bucket: RpcUsageBucket, key: string): void {
    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, { ...bucket, counters: { ...bucket.counters } });
      return;
    }
    for (const [name, value] of Object.entries(bucket.counters) as [
      RpcUsageCounter,
      number,
    ][]) {
      existing.counters[name] = (existing.counters[name] ?? 0) + value;
    }
  }

  // Bounded while the app is unreachable: the oldest hours go first.
  private trim(): void {
    if (this.buckets.size <= this.maxRetainedBuckets) {
      return;
    }
    const byAge = [...this.buckets.entries()].sort(([, a], [, b]) =>
      a.hour.localeCompare(b.hour),
    );
    for (const [key] of byAge.slice(
      0,
      this.buckets.size - this.maxRetainedBuckets,
    )) {
      this.buckets.delete(key);
    }
  }
}
