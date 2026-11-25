import { postSignedInternal } from "../../lib/utils/fetch-utils";
import { logger } from "../../lib/utils/logger";
import type {
  RpcUsageAttribution,
  RpcUsageRecorder,
} from "../chains/route-provider-pool";
import {
  RPC_USAGE_INGEST_PATH,
  type RpcUsageCounter,
} from "../chains/rpc-route";

export const USAGE_FLUSH_INTERVAL_MS = 30_000;
export const USAGE_MAX_BUCKETS_PER_REQUEST = 1000;
/** Ceiling on buckets held across failed deliveries; the oldest hours go first. */
export const USAGE_MAX_HELD_BUCKETS = 10_000;
const USAGE_POST_TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;

export type UsageCounters = Partial<Record<RpcUsageCounter, number>>;

export interface UsageBucket extends RpcUsageAttribution {
  /** ISO start of the UTC hour the counts fall in. */
  hour: string;
  counters: UsageCounters;
}

/** Delivers one raw JSON body; resolves true when the app accepted it. */
export type UsageSender = (rawBody: string) => Promise<boolean>;

export interface RpcUsageReporterOptions {
  send?: UsageSender;
  now?: () => number;
  maxHeldBuckets?: number;
}

const defaultSender: UsageSender = (rawBody) =>
  postSignedInternal(
    RPC_USAGE_INGEST_PATH,
    rawBody,
    AbortSignal.timeout(USAGE_POST_TIMEOUT_MS),
  );

function hourStart(now: number): string {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

function bucketKey(attribution: RpcUsageAttribution, hour: string): string {
  return JSON.stringify([
    attribution.organizationId,
    attribution.configId,
    attribution.origin,
    attribution.chainId,
    attribution.transport,
    hour,
  ]);
}

function addCounters(target: UsageCounters, source: UsageCounters): void {
  for (const [name, value] of Object.entries(source) as [
    RpcUsageCounter,
    number,
  ][]) {
    target[name] = (target[name] ?? 0) + value;
  }
}

/**
 * Hourly usage counts for organization routes, posted to the app on an
 * interval. Counts from a failed delivery are kept for the next attempt.
 */
export class RpcUsageReporter implements RpcUsageRecorder {
  private readonly buckets = new Map<string, UsageBucket>();
  private readonly send: UsageSender;
  private readonly now: () => number;
  private readonly maxHeldBuckets: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(opts: RpcUsageReporterOptions = {}) {
    this.send = opts.send ?? defaultSender;
    this.now = opts.now ?? Date.now;
    this.maxHeldBuckets = opts.maxHeldBuckets ?? USAGE_MAX_HELD_BUCKETS;
  }

  record(
    attribution: RpcUsageAttribution,
    counter: RpcUsageCounter,
    count: number,
  ): void {
    if (!(Number.isFinite(count) && count > 0)) {
      return;
    }
    this.merge({
      organizationId: attribution.organizationId,
      configId: attribution.configId,
      origin: attribution.origin,
      chainId: attribution.chainId,
      transport: attribution.transport,
      hour: hourStart(this.now()),
      counters: { [counter]: count },
    });
    this.enforceCap();
  }

  pendingBuckets(): UsageBucket[] {
    return [...this.buckets.values()].map((bucket) => ({
      ...bucket,
      counters: { ...bucket.counters },
    }));
  }

  start(intervalMs: number = USAGE_FLUSH_INTERVAL_MS): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    await this.flush();
  }

  flush(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.deliver().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async deliver(): Promise<void> {
    if (this.buckets.size === 0) {
      return;
    }
    const pending = [...this.buckets.values()];
    this.buckets.clear();
    for (let i = 0; i < pending.length; i += USAGE_MAX_BUCKETS_PER_REQUEST) {
      const chunk = pending.slice(i, i + USAGE_MAX_BUCKETS_PER_REQUEST);
      let accepted = false;
      try {
        accepted = await this.send(JSON.stringify({ buckets: chunk }));
      } catch {
        accepted = false;
      }
      if (!accepted) {
        const kept = pending.slice(i);
        for (const bucket of kept) {
          this.merge(bucket);
        }
        this.enforceCap();
        logger.warn(
          `[RpcUsage] usage report not accepted; keeping ${this.buckets.size} bucket(s) for the next attempt`,
        );
        return;
      }
    }
  }

  private merge(bucket: UsageBucket): void {
    const key = bucketKey(bucket, bucket.hour);
    const existing = this.buckets.get(key);
    if (existing) {
      addCounters(existing.counters, bucket.counters);
      return;
    }
    this.buckets.set(key, { ...bucket, counters: { ...bucket.counters } });
  }

  private enforceCap(): void {
    const excess = this.buckets.size - this.maxHeldBuckets;
    if (excess <= 0) {
      return;
    }
    const oldest = [...this.buckets.entries()]
      .sort(([, a], [, b]) => a.hour.localeCompare(b.hour))
      .slice(0, excess);
    for (const [key] of oldest) {
      this.buckets.delete(key);
    }
    logger.warn(
      `[RpcUsage] dropped ${excess} oldest usage bucket(s) over the cap`,
    );
  }
}
