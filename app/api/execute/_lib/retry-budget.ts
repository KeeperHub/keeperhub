import "server-only";

import { PROCESSING_TTL_MS as IDEMPOTENCY_PROCESSING_TTL_MS } from "@/lib/idempotency";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS as DEFAULT_RETRY_TIMEOUT_MS,
} from "./retry";
import type { RetryConfig } from "./types";

// The worst-case retry budget (timeoutMs x attempts) must not exceed the
// idempotency processing-lock TTL, so a single request cannot outlive its own
// reservation and have a reclaimer take the slot mid-flight.
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
    return {
      valid: false,
      error: `retry budget (timeoutMs x (maxRetries + 1)) must not exceed ${MAX_RETRY_BUDGET_MS}ms`,
    };
  }

  return {
    valid: true,
    data: {
      maxRetries: r.maxRetries as number | undefined,
      timeoutMs: r.timeoutMs as number | undefined,
    },
  };
}
