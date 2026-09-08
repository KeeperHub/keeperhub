import type {
  AnalyticsStreamEvent,
  AnalyticsSummary,
  TimeRange,
} from "@/lib/analytics/types";

export const POLL_INTERVAL_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MAX_LIFETIME_MS = 5 * 60 * 1000;
export const MIN_EVENT_INTERVAL_MS = 1000;
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function formatSSE(event: AnalyticsStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export type AnalyticsStreamDeps = {
  getChecksum: (organizationId: string) => Promise<string>;
  getSummary: (
    organizationId: string,
    range: TimeRange,
    customStart?: string,
    customEnd?: string,
    projectId?: string
  ) => Promise<AnalyticsSummary>;
};

export type AnalyticsStreamConfig = {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxLifetimeMs?: number;
  minEventIntervalMs?: number;
  maxConsecutiveFailures?: number;
};

export type AnalyticsStreamOpts = {
  signal: AbortSignal;
  organizationId: string;
  range: TimeRange;
  customStart?: string;
  customEnd?: string;
  projectId?: string;
  deps: AnalyticsStreamDeps;
  config?: AnalyticsStreamConfig;
};

export function createAnalyticsStreamStart(
  opts: AnalyticsStreamOpts
): (controller: ReadableStreamDefaultController<Uint8Array>) => void {
  const {
    signal,
    organizationId,
    range,
    customStart,
    customEnd,
    projectId,
    deps,
    config,
  } = opts;
  const pollIntervalMs = config?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const heartbeatIntervalMs =
    config?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const maxLifetimeMs = config?.maxLifetimeMs ?? MAX_LIFETIME_MS;
  const minEventIntervalMs =
    config?.minEventIntervalMs ?? MIN_EVENT_INTERVAL_MS;
  const maxConsecutiveFailures =
    config?.maxConsecutiveFailures ?? MAX_CONSECUTIVE_POLL_FAILURES;

  return (controller): void => {
    const encoder = new TextEncoder();
    const startTime = Date.now();

    let lastChecksum = "";
    let lastEventTime = 0;
    let closed = false;
    let primed = false;
    let consecutiveFailures = 0;

    const safeClose = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      signal.removeEventListener("abort", onAbort);
      try {
        controller.close();
      } catch {
        // controller may already be closed by the platform
      }
    };

    const safeEnqueue = (chunk: Uint8Array): boolean => {
      if (closed) {
        return false;
      }
      try {
        controller.enqueue(chunk);
        return true;
      } catch {
        safeClose();
        return false;
      }
    };

    const fetchSummaryEvent = async (): Promise<Uint8Array> => {
      const summary = await deps.getSummary(
        organizationId,
        range,
        customStart,
        customEnd,
        projectId
      );

      const event: AnalyticsStreamEvent = {
        type: "summary",
        data: summary,
      };

      return encoder.encode(formatSSE(event));
    };

    const pollTimer = setInterval(async (): Promise<void> => {
      if (closed) {
        return;
      }

      if (Date.now() - startTime > maxLifetimeMs) {
        safeClose();
        return;
      }

      try {
        const checksum = await deps.getChecksum(organizationId);

        if (closed) {
          return;
        }

        // The poll itself worked, so the stream is healthy. Only the checksum
        // read counts towards giving up; a failing summary deliberately keeps
        // the stream open (see the catch).
        consecutiveFailures = 0;

        // The first checksum only records where this stream started. The client
        // already fetched the summary over HTTP when it mounted, so pushing one
        // here buys it nothing - and because maxLifetimeMs closes every stream
        // after a few minutes, doing so made every viewer force a full summary
        // recompute on every reconnect, whether or not anything had changed.
        if (!primed) {
          primed = true;
          lastChecksum = checksum;
          return;
        }

        if (checksum === lastChecksum) {
          return;
        }

        lastChecksum = checksum;

        const now = Date.now();
        if (now - lastEventTime < minEventIntervalMs) {
          return;
        }
        lastEventTime = now;

        const chunk = await fetchSummaryEvent();

        if (closed) {
          return;
        }

        safeEnqueue(chunk);
      } catch {
        // One failed poll is not fatal. Closing here sent the browser straight
        // into a reconnect, and the reconnect re-ran the work that had just
        // failed, which is how a single slow query turned into a sustained
        // burst on 2026-09-04. Skip the tick instead, and give up only once the
        // checksum read itself has failed repeatedly.
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          safeClose();
        }
      }
    }, pollIntervalMs);

    const heartbeatTimer = setInterval((): void => {
      if (closed) {
        return;
      }

      const event: AnalyticsStreamEvent = {
        type: "heartbeat",
        data: { timestamp: new Date().toISOString() },
      };
      safeEnqueue(encoder.encode(formatSSE(event)));
    }, heartbeatIntervalMs);

    const onAbort = (): void => {
      safeClose();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  };
}
