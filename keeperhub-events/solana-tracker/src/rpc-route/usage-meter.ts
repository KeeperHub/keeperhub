import {
  RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
  RPC_USAGE_MAX_RETAINED_BUCKETS,
  type RpcOrigin,
  type RpcTransport,
  type UsageCounter,
} from "./constants";
import {
  type PostReport,
  type QueuedUsageBucket,
  UsageReportQueue,
} from "./usage-report-queue";

export interface UsageDimensions {
  organizationId: string;
  configId: string | null;
  origin: RpcOrigin;
  chainId: number;
  transport: RpcTransport;
}

export type UsageBucket = QueuedUsageBucket;

/** Bound to one endpoint; called each time that endpoint does something counted. */
export type UsageRecorder = (counter: UsageCounter, amount?: number) => void;

/** Pending usage per endpoint and UTC hour; holds identifiers, never URLs. */
export class UsageMeter {
  private readonly queue: UsageReportQueue;

  constructor(
    maxBuckets: number = RPC_USAGE_MAX_RETAINED_BUCKETS,
    now: () => number = Date.now,
  ) {
    this.queue = new UsageReportQueue({
      maxHeldBuckets: maxBuckets,
      maxBucketsPerReport: RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
      now,
    });
  }

  get size(): number {
    return this.queue.size;
  }

  recorderFor(dims: UsageDimensions): UsageRecorder {
    const fixed: UsageDimensions = { ...dims };
    return (counter, amount = 1) => this.record(fixed, counter, amount);
  }

  record(dims: UsageDimensions, counter: UsageCounter, amount = 1): void {
    this.queue.record(dims, counter, amount);
  }

  /** Copies of every bucket not yet stored, oldest report first. */
  pendingBuckets(): UsageBucket[] {
    return this.queue.pendingBuckets();
  }

  sendWith(post: PostReport): Promise<void> {
    return this.queue.sendWith(post);
  }
}
