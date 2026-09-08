import "server-only";

import { Agent, request as httpRequest } from "node:http";
import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  decodeSandboxResult,
  SANDBOX_RESULT_MAX_BYTES,
  SANDBOX_WIRE_VERSION,
} from "@/lib/sandbox/child-source";

const SANDBOX_URL = process.env.SANDBOX_URL;
const RESULT_SENTINEL = "\u0001RESULT\u0002";

// Parse an integer env override, falling back to `fallback` when unset or
// invalid (non-numeric, NaN, or below `min`). Mirrors the server's
// getMaxBodyBytes guard so a stray negative value cannot silently become a
// negative byte cap (rejecting every response) or skip the retry loop.
function parseIntEnv(
  raw: string | undefined,
  fallback: number,
  min: number
): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// HTTP budget on top of the user-code timeout. Sandbox server's in-child
// wall-clock kill adds 1000 ms; we give 2000 ms more for network RTT,
// TCP teardown, and kubeproxy conntrack flush. If the socket yields no
// response within (timeoutMs + HTTP_SLACK_MS), we destroy it so the
// caller sees a timeout instead of hanging on a dead peer.
const HTTP_SLACK_MS = parseIntEnv(process.env.SANDBOX_HTTP_SLACK_MS, 3000, 0);

const sandboxAgent = new Agent({
  keepAlive: true,
  maxSockets: 50,
});

// The sandbox sheds load with 429 + Retry-After before it reads the body or
// spawns a child, so a momentary concurrency overshoot is cheap to retry: a
// short backoff lets the in-flight runs on the pod drain instead of surfacing
// a hard error to the caller. Bounded so sustained saturation still fails
// fast rather than amplifying load on an already-full sandbox.
const MAX_CAPACITY_RETRIES = parseIntEnv(process.env.SANDBOX_MAX_RETRIES, 3, 0);

// Base backoff for the first retry. We deliberately compute the wait from a
// fixed schedule rather than the response's Retry-After: deriving a timer
// duration from an HTTP header is a resource-exhaustion risk, and our sandbox
// always signals a 1s backoff anyway.
const BASE_BACKOFF_MS = 500;

// Hard ceiling on any single backoff so a sustained-saturation retry chain
// cannot pin a workflow step on a long timer.
const MAX_BACKOFF_MS = 5000;

// Random spread added to each backoff so concurrent callers retrying the same
// overflow do not resynchronize into a thundering herd against the sandbox.
const RETRY_JITTER_MS = 250;

const HTTP_TOO_MANY_REQUESTS = 429;

// Hard ceiling on the response body the client will buffer from the (untrusted)
// sandbox. Mirrors the local fd-3 frame cap so a compromised sandbox cannot pin
// main-app memory by streaming an unbounded body within the time budget.
// Env-overridable; falls back to the frame cap on a missing/invalid value.
const MAX_RESPONSE_BYTES = parseIntEnv(
  process.env.SANDBOX_MAX_RESPONSE_BYTES,
  SANDBOX_RESULT_MAX_BYTES,
  1
);

/**
 * Carries the HTTP status off a non-200 sandbox response so runRemote can
 * distinguish a retryable capacity 429 from a terminal error without
 * string-matching the message.
 */
class SandboxHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SandboxHttpError";
    this.statusCode = statusCode;
  }
}

/** Exponential backoff for the nth retry (0-indexed), capped and jittered.
 * Derived only from constants so no response-controlled value reaches the
 * timer. */
function backoffForAttempt(attempt: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  return capped + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/** Abort-aware delay used between capacity retries. Rejects if the caller's
 * signal fires while we are backing off so a client disconnect short-circuits
 * the wait instead of pinning the workflow step for the full backoff. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export type LogEntry = {
  level: "log" | "warn" | "error";
  args: unknown[];
};

export type ChildOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

export type RunCodeResult =
  | { success: true; result: unknown; logs: LogEntry[] }
  | {
      success: false;
      error: string;
      logs: LogEntry[];
      line?: number;
      errorClass?: ExecutionErrorType;
    };

const VM_LINE_REGEX = /user-code\.js:(\d+)/;

export function extractLineNumber(
  stack: string | undefined
): number | undefined {
  // Defensive: the decoded outcome crosses an untrusted boundary, so `stack`
  // may not actually be a string at runtime; `.match` on a non-string throws.
  if (typeof stack !== "string") {
    return undefined;
  }
  const match = stack.match(VM_LINE_REGEX);
  if (match?.[1]) {
    const rawLine = Number.parseInt(match[1], 10);
    return Math.max(1, rawLine - 1);
  }
  return undefined;
}

function postOnce(
  body: Buffer,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    if (!SANDBOX_URL) {
      reject(new Error("SANDBOX_URL is not set"));
      return;
    }

    const url = new URL("/run", SANDBOX_URL);
    const defaultPort = url.protocol === "https:" ? 443 : 80;
    const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;

    let settled = false;
    let budgetTimer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (budgetTimer) {
        clearTimeout(budgetTimer);
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
      action();
    };

    const req = httpRequest(
      {
        agent: sandboxAgent,
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length.toString(),
          "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            settle(() => {
              req.destroy();
              reject(
                new Error(
                  `sandbox response exceeds maximum size (${MAX_RESPONSE_BYTES} bytes)`
                )
              );
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settle(() => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
              reject(
                new SandboxHttpError(
                  res.statusCode ?? 0,
                  `sandbox returned ${res.statusCode ?? "no status"}: ${buf.toString("utf8").slice(0, 200)}`
                )
              );
              return;
            }
            // Fail fast on a wire-version skew (e.g. this newer client talking
            // to an older sandbox that does not speak tagged-JSON) with a clear
            // message rather than a downstream JSON parse error.
            const wire = res.headers["x-kh-sandbox-wire"];
            if (wire !== SANDBOX_WIRE_VERSION) {
              reject(
                new Error(
                  `sandbox wire version mismatch: expected ${SANDBOX_WIRE_VERSION}, got ${typeof wire === "string" ? wire : "none"}`
                )
              );
              return;
            }
            resolve(buf);
          });
        });
        res.on("error", (err: Error) => {
          settle(() => reject(err));
        });
      }
    );
    req.on("error", (err: Error) => {
      settle(() => reject(err));
    });

    const totalBudgetMs = timeoutMs + HTTP_SLACK_MS;
    budgetTimer = setTimeout(() => {
      settle(() => {
        req.destroy();
        reject(new Error(`sandbox request timed out after ${totalBudgetMs}ms`));
      });
    }, totalBudgetMs);

    if (signal) {
      onAbort = (): void => {
        settle(() => {
          req.destroy();
          reject(new Error("aborted"));
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.write(body);
    req.end();
  });
}

/**
 * Shape guard for the decoded response. The sandbox is untrusted, so the
 * tagged-JSON payload is validated to be a ChildOutcome envelope before use.
 */
export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as { level?: unknown; args?: unknown };
  return typeof e.level === "string" && Array.isArray(e.args);
}

export function isChildOutcome(value: unknown): value is ChildOutcome {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as {
    ok?: unknown;
    logs?: unknown;
    errorMessage?: unknown;
    errorStack?: unknown;
  };
  if (typeof v.ok !== "boolean" || !Array.isArray(v.logs)) {
    return false;
  }
  // Every log entry must be well-shaped so a forged logs array cannot surface a
  // null/garbage entry to downstream consumers on this untrusted boundary.
  if (!v.logs.every(isLogEntry)) {
    return false;
  }
  if (v.ok === true) {
    // ok:true's `result` is unknown by design.
    return true;
  }
  // ok:false must carry a string errorMessage and, if present, a string
  // errorStack: toRunCodeResult passes errorStack to extractLineNumber, which
  // calls `.match` on it, so a non-string would throw and mask the real error.
  return (
    typeof v.errorMessage === "string" &&
    (v.errorStack === undefined || typeof v.errorStack === "string")
  );
}

function parseResponse(buf: Buffer): ChildOutcome {
  const text = buf.toString("utf8");
  const idx = text.lastIndexOf(RESULT_SENTINEL);
  if (idx === -1) {
    throw new Error("sandbox response missing sentinel");
  }
  const payload = text.slice(idx + RESULT_SENTINEL.length).trim();
  // Safe by construction: JSON.parse + tag rebuild (prototype-pollution-safe),
  // never v8.deserialize on sandbox-produced bytes (F-010).
  const decoded = decodeSandboxResult(payload);
  if (!isChildOutcome(decoded)) {
    throw new Error("sandbox response: malformed result");
  }
  return decoded;
}

function toRunCodeResult(outcome: ChildOutcome): RunCodeResult {
  if (outcome.ok) {
    return { success: true, result: outcome.result, logs: outcome.logs };
  }
  const line = extractLineNumber(outcome.errorStack);
  const base: RunCodeResult = {
    success: false,
    error: outcome.errorMessage,
    logs: outcome.logs,
  };
  if (line !== undefined) {
    base.line = line;
  }
  return base;
}

export async function runRemote(input: {
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<RunCodeResult> {
  try {
    const timeoutSeconds = Math.ceil(input.timeoutMs / 1000);
    const body = Buffer.from(
      JSON.stringify({ code: input.code, timeout: timeoutSeconds }),
      "utf8"
    );

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_CAPACITY_RETRIES; attempt++) {
      try {
        const responseBuf = await postOnce(body, input.timeoutMs, input.signal);
        const outcome = parseResponse(responseBuf);
        return toRunCodeResult(outcome);
      } catch (err) {
        lastError = err;
        // Only a capacity 429 is retryable: the run never started, so resending
        // is safe. Any other failure (5xx, malformed, network) is terminal.
        if (
          err instanceof SandboxHttpError &&
          err.statusCode === HTTP_TOO_MANY_REQUESTS &&
          attempt < MAX_CAPACITY_RETRIES
        ) {
          await delay(backoffForAttempt(attempt), input.signal);
          continue;
        }
        break;
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    return {
      success: false,
      error: `sandbox client error: ${message}`,
      logs: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `sandbox client error: ${message}`,
      logs: [],
    };
  }
}
