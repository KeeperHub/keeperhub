import { KEEPERHUB_API_URL } from "../../lib/config/environment";
import { signHmacHeaders } from "../../lib/utils/fetch-utils";
import {
  RPC_USAGE_FLUSH_INTERVAL_MS,
  RPC_USAGE_INGEST_PATH,
  RPC_USAGE_POST_TIMEOUT_MS,
} from "./constants";
import type { UsageMeter } from "./usage-meter";

/** Sends one raw JSON body to an internal app path; resolves with the HTTP status, 0 for none. */
export type SignedPost = (path: string, body: string) => Promise<number>;

/** Signs the exact bytes it sends, the same scheme discovery uses for its GET. */
export const postSigned: SignedPost = async (path, body) => {
  const url = `${KEEPERHUB_API_URL}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...signHmacHeaders("POST", url, body, "events"),
    },
    body,
    signal: AbortSignal.timeout(RPC_USAGE_POST_TIMEOUT_MS),
  }).catch(() => null);
  return response?.status ?? 0;
};

/** Reports the meter; a report that got no answer is kept for the next run. Never logs. */
export function flushUsage(
  meter: UsageMeter,
  post: SignedPost = postSigned,
): Promise<void> {
  return meter.sendWith((body) => post(RPC_USAGE_INGEST_PATH, body));
}

export interface UsageReporter {
  start(): void;
  /** Stops the timer and reports once more. */
  stop(): Promise<void>;
  flush(): Promise<void>;
}

export function createUsageReporter(
  meter: UsageMeter,
  post: SignedPost = postSigned,
  intervalMs: number = RPC_USAGE_FLUSH_INTERVAL_MS,
): UsageReporter {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = flushUsage(meter, post).finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  return {
    start(): void {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        void flush();
      }, intervalMs);
      timer.unref?.();
    },
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight;
      }
      await flush();
    },
    flush,
  };
}
