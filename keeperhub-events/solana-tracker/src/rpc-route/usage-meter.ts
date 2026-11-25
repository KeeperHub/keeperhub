import {
  RPC_USAGE_MAX_RETAINED_BUCKETS,
  type RpcOrigin,
  type RpcTransport,
  type UsageCounter,
  utcHourStart,
} from "./constants";

export interface UsageDimensions {
  organizationId: string;
  configId: string | null;
  origin: RpcOrigin;
  chainId: number;
  transport: RpcTransport;
}

export type UsageCounters = Partial<Record<UsageCounter, number>>;

export interface UsageBucket extends UsageDimensions {
  /** ISO start of the UTC hour the counts fall in. */
  hour: string;
  counters: UsageCounters;
}

/** Bound to one endpoint; called each time that endpoint does something counted. */
export type UsageRecorder = (counter: UsageCounter, amount?: number) => void;

function bucketKey(dims: UsageDimensions, hour: string): string {
  return JSON.stringify([
    dims.organizationId,
    dims.configId,
    dims.origin,
    dims.chainId,
    dims.transport,
    hour,
  ]);
}

/** Pending usage per endpoint and UTC hour; holds identifiers, never URLs. */
export class UsageMeter {
  private buckets = new Map<string, UsageBucket>();

  constructor(
    private readonly maxBuckets: number = RPC_USAGE_MAX_RETAINED_BUCKETS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  recorderFor(dims: UsageDimensions): UsageRecorder {
    const fixed: UsageDimensions = { ...dims };
    return (counter, amount = 1) => this.record(fixed, counter, amount);
  }

  record(dims: UsageDimensions, counter: UsageCounter, amount = 1): void {
    if (amount <= 0) {
      return;
    }
    const { counters } = this.bucketFor(dims, utcHourStart(this.now()));
    counters[counter] = (counters[counter] ?? 0) + amount;
  }

  /** Every pending bucket, oldest first; the meter is left empty. */
  drain(): UsageBucket[] {
    const drained = [...this.buckets.values()];
    this.buckets = new Map();
    return drained;
  }

  /** Puts unsent buckets back, merging with anything counted since. */
  restore(buckets: readonly UsageBucket[]): void {
    for (const bucket of buckets) {
      const target = this.bucketFor(bucket, bucket.hour);
      for (const [counter, value] of Object.entries(bucket.counters) as [
        UsageCounter,
        number,
      ][]) {
        target.counters[counter] = (target.counters[counter] ?? 0) + value;
      }
    }
  }

  private bucketFor(dims: UsageDimensions, hour: string): UsageBucket {
    const key = bucketKey(dims, hour);
    const existing = this.buckets.get(key);
    if (existing) {
      return existing;
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.buckets.delete(oldest);
    }
    const bucket: UsageBucket = {
      organizationId: dims.organizationId,
      configId: dims.configId,
      origin: dims.origin,
      chainId: dims.chainId,
      transport: dims.transport,
      hour,
      counters: {},
    };
    this.buckets.set(key, bucket);
    return bucket;
  }
}
