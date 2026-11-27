import { postSignedInternal } from "../../lib/utils/fetch-utils";
import type {
  RpcUsageAttribution,
  RpcUsageRecorder,
} from "../chains/route-provider-pool";
import {
  RPC_USAGE_INGEST_PATH,
  type RpcUsageCounter,
} from "../chains/rpc-route";
import {
  type PostReport,
  type QueuedUsageBucket,
  UsageReportQueue,
} from "./usage-report-queue";

export const USAGE_FLUSH_INTERVAL_MS = 30_000;
export const USAGE_MAX_BUCKETS_PER_REQUEST = 1000;
/** Ceiling on buckets held across failed deliveries; the oldest hours go first. */
export const USAGE_MAX_HELD_BUCKETS = 10_000;
const USAGE_POST_TIMEOUT_MS = 10_000;

export type UsageBucket = QueuedUsageBucket;

export interface RpcUsageReporterOptions {
  send?: PostReport;
  now?: () => number;
  maxHeldBuckets?: number;
}

const defaultSender: PostReport = (rawBody) =>
  postSignedInternal(
    RPC_USAGE_INGEST_PATH,
    rawBody,
    AbortSignal.timeout(USAGE_POST_TIMEOUT_MS),
  );

/**
 * Hourly usage counts for organization routes, posted to the app on an
 * interval. A report that got no answer is sent again, unchanged.
 */
export class RpcUsageReporter implements RpcUsageRecorder {
  private readonly queue: UsageReportQueue;
  private readonly send: PostReport;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(opts: RpcUsageReporterOptions = {}) {
    this.send = opts.send ?? defaultSender;
    this.queue = new UsageReportQueue({
      maxHeldBuckets: opts.maxHeldBuckets ?? USAGE_MAX_HELD_BUCKETS,
      maxBucketsPerReport: USAGE_MAX_BUCKETS_PER_REQUEST,
      now: opts.now,
    });
  }

  record(
    attribution: RpcUsageAttribution,
    counter: RpcUsageCounter,
    count: number,
  ): void {
    this.queue.record(attribution, counter, count);
  }

  pendingBuckets(): UsageBucket[] {
    return this.queue.pendingBuckets();
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
      this.inFlight = this.queue.sendWith(this.send).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }
}
