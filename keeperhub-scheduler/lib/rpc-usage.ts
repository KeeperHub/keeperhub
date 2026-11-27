/** Hourly usage of organization RPC endpoints, reported to the app without urls. */

import { postSignedOnce } from "./http-client.js";
import {
  RPC_USAGE_FLUSH_INTERVAL_MS,
  RPC_USAGE_INGEST_PATH,
  RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
  RPC_USAGE_MAX_RETAINED_BUCKETS,
  type RpcOrigin,
  type RpcTransport,
  type RpcUsageCounter,
} from "./rpc-route.js";
import {
  type PostReport,
  type QueuedUsageBucket,
  UsageReportQueue,
} from "./usage-report-queue.js";

/** The endpoint usage is attributed to. */
export type RpcUsageSource = {
  organizationId: string;
  configId: string | null;
  origin: RpcOrigin;
  chainId: number;
  transport: RpcTransport;
};

export type RpcUsageBucket = QueuedUsageBucket;

type RpcUsageReporterOptions = {
  send?: PostReport;
  now?: () => number;
  maxRetainedBuckets?: number;
};

const postUsage: PostReport = (body) =>
  postSignedOnce(RPC_USAGE_INGEST_PATH, body);

export class RpcUsageReporter {
  private readonly queue: UsageReportQueue;
  private readonly send: PostReport;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(options: RpcUsageReporterOptions = {}) {
    this.send = options.send ?? postUsage;
    this.queue = new UsageReportQueue({
      maxHeldBuckets:
        options.maxRetainedBuckets ?? RPC_USAGE_MAX_RETAINED_BUCKETS,
      maxBucketsPerReport: RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
      now: options.now,
    });
  }

  record(source: RpcUsageSource, counter: RpcUsageCounter, count = 1): void {
    this.queue.record(source, counter, count);
  }

  pendingBuckets(): RpcUsageBucket[] {
    return this.queue.pendingBuckets();
  }

  start(intervalMs: number = RPC_USAGE_FLUSH_INTERVAL_MS): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.flush().catch(() => {
        // the queue keeps an unanswered report for the next attempt
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
    if (!this.flushing) {
      this.flushing = this.queue.sendWith(this.send).finally(() => {
        this.flushing = null;
      });
    }
    await this.flushing;
  }
}
