import "server-only";

import { PROCESSING_TTL_MS as IDEMPOTENCY_PROCESSING_TTL_MS } from "@/lib/idempotency";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS as DEFAULT_RETRY_TIMEOUT_MS,
} from "./retry";
import type { RetryConfig } from "./types";

// The worst-case retry budget (timeoutMs x attempts) must not exceed the
// idempotency processing-lock TTL. The route also keeps the lock alive with a
// heartbeat, but that is fire-and-forget; this budget is the invariant that
// holds without depending on it.
const MAX_RETRY_BUDGET_MS = IDEMPOTENCY_PROCESSING_TTL_MS;

export function validateRetryConfig(
  raw: unknown
): { valid: true; data: RetryConfig } | { valid: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "retry must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  if (
    r.maxRetries !== undefined &&
    (typeof r.maxRetries !== "number" || r.maxRetries < 0 || r.maxRetries > 10)
  ) {
    return {
      valid: false,
      error: "retry.maxRetries must be a number between 0 and 10",
    };
  }
  if (
    r.timeoutMs !== undefined &&
    (typeof r.timeoutMs !== "number" ||
      r.timeoutMs < 1000 ||
      r.timeoutMs > 600_000)
  ) {
    return {
      valid: false,
      error: "retry.timeoutMs must be a number between 1000 and 600000",
    };
  }

  // The budget has to be sized against what the executor will do, not
  // against the request. An omitted maxRetries resolves to
  // DEFAULT_MAX_RETRIES in resolveConfig, so defaulting to 0 here validated
  // one attempt against a run of four -- four times the intended ceiling,
  // and past the idempotency lock TTL this budget exists to stay inside.
  const attempts =
    ((r.maxRetries as number | undefined) ?? DEFAULT_MAX_RETRIES) + 1;
  const perAttempt =
    (r.timeoutMs as number | undefined) ?? DEFAULT_RETRY_TIMEOUT_MS;
  if (attempts * perAttempt > MAX_RETRY_BUDGET_MS) {
    return { valid: false, error: retryBudgetError(r, attempts, perAttempt) };
  }

  return {
    valid: true,
    data: {
      maxRetries: r.maxRetries as number | undefined,
      timeoutMs: r.timeoutMs as number | undefined,
    },
  };
}

/**
 * Why a retry config is over budget, in terms the caller can act on safely.
 *
 * The message has to name the attempt count the executor will actually run,
 * and where it came from when the caller did not set it. Without that, a
 * caller who sent only `timeoutMs: 600000` reads "timeoutMs x (maxRetries + 1)",
 * computes 600000 x 1, and cannot see why it was refused.
 *
 * It also has to point at the safe fix. The obvious one -- lowering timeoutMs
 * to keep four attempts -- is the dangerous one: withTimeout races a timer
 * rather than cancelling, so an attempt that times out can still broadcast
 * while the next signs at the following nonce, putting two transactions on
 * chain. Setting maxRetries to 0 keeps the long timeout and one attempt.
 */
function retryBudgetError(
  r: Record<string, unknown>,
  attempts: number,
  perAttempt: number
): string {
  const retriesSource =
    r.maxRetries === undefined
      ? `maxRetries was not set, so it defaults to ${DEFAULT_MAX_RETRIES}`
      : `maxRetries is ${String(r.maxRetries)}`;
  const timeoutSource =
    r.timeoutMs === undefined
      ? `timeoutMs was not set, so it defaults to ${DEFAULT_RETRY_TIMEOUT_MS}ms`
      : `timeoutMs is ${String(r.timeoutMs)}ms`;
  return (
    `retry budget exceeded: ${retriesSource} and ${timeoutSource}, ` +
    `so up to ${attempts} attempts of ${perAttempt}ms may run ` +
    `(${attempts * perAttempt}ms), over the ${MAX_RETRY_BUDGET_MS}ms limit. ` +
    "To keep a long timeout, set retry.maxRetries to 0 for a single attempt. " +
    "Lowering timeoutMs instead is not a safe substitute for a write: an " +
    "attempt that times out can still be broadcast while the next one is sent."
  );
}
