/**
 * Hourly usage of organization RPC endpoints, held until the app stores it.
 *
 * Counts are kept per endpoint and UTC hour, and sent in reports the app
 * stores once by id. A report that got no answer is sent again unchanged, so
 * a lost reply never counts twice; one the app refuses is dropped, so a bad
 * report cannot block the ones after it.
 *
 * Kept identical in keeperhub-events/event-tracker, keeperhub-events/
 * solana-tracker and keeperhub-scheduler; a test in the app checks the copies.
 */

import { randomUUID } from "node:crypto";

const HOUR_MS = 3_600_000;
const HTTP_OK_MIN = 200;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

/** The endpoint, chain and transport usage is attributed to. */
export interface UsageSource {
  organizationId: string;
  configId: string | null;
  origin: string;
  chainId: number;
  transport: string;
}

export interface QueuedUsageBucket extends UsageSource {
  /** ISO start of the UTC hour the counts fall in. */
  hour: string;
  counters: Record<string, number>;
}

/** What the app did with a report. */
export type ReportOutcome = "stored" | "refused" | "unanswered";

/** Posts one report body; resolves with the HTTP status, or 0 for none. */
export type PostReport = (rawBody: string) => Promise<number>;

export interface UsageReportQueueOptions {
  maxHeldBuckets: number;
  maxBucketsPerReport: number;
  now?: () => number;
}

interface PendingReport {
  reportId: string;
  buckets: QueuedUsageBucket[];
}

export function utcHourStart(atMs: number): string {
  return new Date(Math.floor(atMs / HOUR_MS) * HOUR_MS).toISOString();
}

/** A 2xx is stored, a 4xx is refused for good, anything else may be retried. */
export function reportOutcomeOf(status: number): ReportOutcome {
  if (status >= HTTP_OK_MIN && status < HTTP_CLIENT_ERROR_MIN) {
    return "stored";
  }
  if (status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN) {
    return "refused";
  }
  return "unanswered";
}

function bucketKey(source: UsageSource, hour: string): string {
  return JSON.stringify([
    source.organizationId,
    source.configId,
    source.origin,
    source.chainId,
    source.transport,
    hour,
  ]);
}

function copyOf(bucket: QueuedUsageBucket): QueuedUsageBucket {
  return { ...bucket, counters: { ...bucket.counters } };
}

export class UsageReportQueue {
  private readonly buckets = new Map<string, QueuedUsageBucket>();
  private pending: PendingReport | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: UsageReportQueueOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Buckets waiting to be stored, the unanswered report's first. */
  get size(): number {
    return (this.pending?.buckets.length ?? 0) + this.buckets.size;
  }

  record(source: UsageSource, counter: string, count = 1): void {
    if (!(Number.isFinite(count) && count > 0)) {
      return;
    }
    const hour = utcHourStart(this.now());
    const key = bucketKey(source, hour);
    const bucket = this.buckets.get(key) ?? {
      organizationId: source.organizationId,
      configId: source.configId,
      origin: source.origin,
      chainId: source.chainId,
      transport: source.transport,
      hour,
      counters: {},
    };
    bucket.counters[counter] = (bucket.counters[counter] ?? 0) + count;
    this.buckets.set(key, bucket);
    this.trim();
  }

  /** Copies of every bucket not yet stored, the unanswered report's first. */
  pendingBuckets(): QueuedUsageBucket[] {
    return [
      ...(this.pending?.buckets ?? []),
      ...this.buckets.values(),
    ].map(copyOf);
  }

  /**
   * Send everything held, one report at a time. Stops at the first report
   * that gets no answer and keeps it, unchanged, for the next call.
   */
  async sendWith(post: PostReport): Promise<void> {
    for (;;) {
      const report = this.pending ?? this.nextReport();
      if (!report) {
        return;
      }
      this.pending = report;
      let status = 0;
      try {
        status = await post(JSON.stringify(report));
      } catch {
        status = 0;
      }
      if (reportOutcomeOf(status) === "unanswered") {
        return;
      }
      this.pending = null;
    }
  }

  private nextReport(): PendingReport | null {
    if (this.buckets.size === 0) {
      return null;
    }
    const buckets: QueuedUsageBucket[] = [];
    for (const [key, bucket] of this.buckets) {
      if (buckets.length >= this.opts.maxBucketsPerReport) {
        break;
      }
      buckets.push(bucket);
      this.buckets.delete(key);
    }
    return { reportId: randomUUID(), buckets };
  }

  // Bounded while the app is unreachable: the oldest hours go first.
  private trim(): void {
    if (this.buckets.size <= this.opts.maxHeldBuckets) {
      return;
    }
    const byAge = [...this.buckets.entries()].sort(([, a], [, b]) =>
      a.hour.localeCompare(b.hour),
    );
    for (const [key] of byAge.slice(
      0,
      this.buckets.size - this.opts.maxHeldBuckets,
    )) {
      this.buckets.delete(key);
    }
  }
}
