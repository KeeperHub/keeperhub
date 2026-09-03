import { createHash, createHmac } from "node:crypto";
import { KEEPERHUB_URL } from "./config.js";

const HMAC_CALLER = "scheduler";

/**
 * Per-attempt budget and retry schedule for internal API calls. A transport
 * failure (connection refused or reset, DNS, the timeout below) or a 5xx reply
 * is retried on the schedule; a 4xx is a definitive answer and is not. Every
 * call this client makes is idempotent, which is what makes a retry safe: the
 * GETs by nature, the phantom POST through its dispatch key, the PATCH through
 * its terminal-status compare-and-set.
 *
 * Keep in sync with the copies in keeperhub-events/event-tracker/lib/phantom.ts
 * and keeperhub-events/solana-tracker/lib/phantom.ts (those packages cannot
 * import this one).
 */
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS: readonly number[] = [500, 1_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface ApiResponse<T> {
  data: T;
  /** 1 when the first attempt was answered; higher when a retry was. */
  attempts: number;
}

type AttemptOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "retry"; error: unknown }
  | { kind: "fail"; error: Error };

function signHmacHeaders(
  method: string,
  url: string,
  body: string,
): Record<string, string> {
  const secret = process.env.INTERNAL_SERVICE_HMAC_SECRET ?? "";
  const pathname = new URL(url).pathname;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signingString = `${method}\n${pathname}\n${HMAC_CALLER}\n${bodyDigest}\n${timestamp}`;
  const signature = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");
  return {
    "X-KH-Caller": HMAC_CALLER,
    "X-KH-Timestamp": timestamp,
    "X-KH-Signature": signature,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function attemptRequest<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<AttemptOutcome<T>> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, init);
  } catch (error) {
    return { kind: "retry", error };
  }
  if (response.ok) {
    return { kind: "ok", data: (await response.json()) as T };
  }
  const text = await response.text();
  const error = new Error(`API ${label} failed: ${response.status} ${text}`);
  return { kind: response.status >= 500 ? "retry" : "fail", error };
}

/**
 * Like apiRequest, but also reports how many attempts the call took. A caller
 * whose reply semantics assume its request was the first to reach the server
 * needs this: after a retry, the reply may be answering for this caller's own
 * earlier attempt whose response was lost, not for another caller's request.
 */
export async function apiRequestWithAttempts<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const url = `${KEEPERHUB_URL}${path}`;
  const method = (options.method ?? "GET").toUpperCase();
  const body = typeof options.body === "string" ? options.body : "";
  const label = `${options.method || "GET"} ${path}`;
  // Signed once for every attempt: the server accepts a timestamp within
  // 300 s, far beyond the whole retry schedule.
  const init: RequestInit = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...signHmacHeaders(method, url, body),
      ...options.headers,
    },
  };

  for (let attempt = 1; ; attempt++) {
    const outcome = await attemptRequest<T>(url, init, label);
    if (outcome.kind === "ok") {
      return { data: outcome.data, attempts: attempt };
    }
    if (outcome.kind === "fail" || attempt === MAX_ATTEMPTS) {
      throw outcome.error;
    }
    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    console.warn(
      `[ApiClient] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${describeError(outcome.error)}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { data } = await apiRequestWithAttempts<T>(path, options);
  return data;
}
