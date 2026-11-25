import { KEEPERHUB_API_URL } from "../../lib/config/environment";
import { signHmacHeaders } from "../../lib/utils/fetch-utils";
import {
  RPC_USAGE_FLUSH_INTERVAL_MS,
  RPC_USAGE_INGEST_PATH,
  RPC_USAGE_MAX_BUCKETS_PER_REQUEST,
  RPC_USAGE_POST_TIMEOUT_MS,
} from "./constants";
import type { UsageMeter } from "./usage-meter";

/** Sends one raw JSON body to an internal app path; resolves true on a 2xx. */
export type SignedPost = (path: string, body: string) => Promise<boolean>;

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
  });
  return response.ok;
};

/** Reports the meter in bounded requests; unsent buckets go back for the next run. Never logs. */
export async function flushUsage(
  meter: UsageMeter,
  post: SignedPost = postSigned,
): Promise<void> {
  const buckets = meter.drain();
  for (let i = 0; i < buckets.length; i += RPC_USAGE_MAX_BUCKETS_PER_REQUEST) {
    const chunk = buckets.slice(i, i + RPC_USAGE_MAX_BUCKETS_PER_REQUEST);
    let accepted = false;
    try {
      accepted = await post(
        RPC_USAGE_INGEST_PATH,
        JSON.stringify({ buckets: chunk }),
      );
    } catch {
      accepted = false;
    }
    if (!accepted) {
      meter.restore(buckets.slice(i));
      return;
    }
  }
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
