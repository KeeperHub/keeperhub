import "server-only";

import type { RetryConfig } from "./types";

const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GAS_BUMP_PERCENT = 10;

export type TransactionResult =
  | { success: true; transactionHash: string; [key: string]: unknown }
  | { success: false; error: string };

type GasBumpOverrides = {
  gasBumpMultiplier?: number;
};

type ExecuteFn<T> = (overrides?: GasBumpOverrides) => Promise<T>;

/**
 * Determines whether a result represents a successful execution.
 * Return true to stop retrying, false to retry (if attempts remain).
 */
type SuccessPredicate<T> = (result: T) => boolean;

/**
 * Extracts an error message from a failed result for retryability checks.
 * Return undefined if the result has no extractable error string.
 */
type ErrorExtractor<T> = (result: T) => string | undefined;

function resolveConfig(config?: RetryConfig): Required<RetryConfig> {
  return {
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    gasBumpPercent: config?.gasBumpPercent ?? DEFAULT_GAS_BUMP_PERCENT,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs)
    ),
  ]);
}

export type RetryResult<T> =
  | { outcome: "success"; result: T; retryCount: number }
  | { outcome: "failed"; result: T; retryCount: number }
  | { outcome: "timeout"; error: string; retryCount: number }
  | { outcome: "exhausted"; error: string; retryCount: number };

type RetryOptions<T> = {
  isSuccess: SuccessPredicate<T>;
  getError: ErrorExtractor<T>;
};

const TX_SUCCESS: SuccessPredicate<TransactionResult> = (r) => r.success;
const TX_ERROR: ErrorExtractor<TransactionResult> = (r) =>
  r.success ? undefined : r.error;

/**
 * Default options for web3 TransactionResult-shaped outputs.
 */
export const transactionRetryOptions: RetryOptions<TransactionResult> = {
  isSuccess: TX_SUCCESS,
  getError: TX_ERROR,
};

/**
 * Options for generic (non-web3) step outputs. Any non-throwing return
 * is treated as success; retries only happen on timeout.
 */
export const genericRetryOptions: RetryOptions<unknown> = {
  isSuccess: () => true,
  getError: () => undefined,
};

/**
 * Execute a function with automatic retry and optional gas price bumping.
 *
 * On timeout or failure, resubmits with a higher gas price multiplier.
 * Each retry bumps the multiplier by gasBumpPercent (default 10%).
 *
 * The executeFn receives optional GasBumpOverrides containing a cumulative
 * gas bump multiplier. The caller is responsible for applying this multiplier
 * to maxFeePerGas/maxPriorityFeePerGas when building the transaction.
 *
 * NOTE: On timeout, the original executeFn promise is abandoned but not cancelled.
 * For EVM transactions this is acceptable -- the retry uses a bumped gas price which
 * acts as a replacement transaction at the same nonce. If the original tx already
 * mined before the retry is submitted, the retry will fail with "nonce already used"
 * which is classified as retryable but will ultimately exhaust retries harmlessly.
 */
export async function executeWithRetry<T>(
  executeFn: ExecuteFn<T>,
  config: RetryConfig | undefined,
  options: RetryOptions<T>
): Promise<RetryResult<T>> {
  const resolved = resolveConfig(config);
  let retryCount = 0;
  let cumulativeBumpMultiplier = 1.0;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt++) {
    const overrides: GasBumpOverrides =
      attempt === 0 ? {} : { gasBumpMultiplier: cumulativeBumpMultiplier };

    const resultOrTimeout = await withTimeout(
      executeFn(overrides),
      resolved.timeoutMs
    );

    if (resultOrTimeout === "timeout") {
      if (attempt >= resolved.maxRetries) {
        return {
          outcome: "timeout",
          error: `Timed out after ${resolved.maxRetries} retries`,
          retryCount,
        };
      }
      retryCount++;
      cumulativeBumpMultiplier *= 1 + resolved.gasBumpPercent / 100;
      continue;
    }

    if (options.isSuccess(resultOrTimeout)) {
      return { outcome: "success", result: resultOrTimeout, retryCount };
    }

    const errorMsg = options.getError(resultOrTimeout);
    const isRetryable = errorMsg ? isRetryableError(errorMsg) : false;
    if (!isRetryable || attempt >= resolved.maxRetries) {
      return { outcome: "failed", result: resultOrTimeout, retryCount };
    }

    retryCount++;
    cumulativeBumpMultiplier *= 1 + resolved.gasBumpPercent / 100;
  }

  return {
    outcome: "exhausted",
    error: "Max retries exceeded",
    retryCount,
  };
}

const RETRYABLE_PATTERNS = [
  "replacement fee too low",
  "nonce has already been used",
  "transaction underpriced",
  "already known",
  "timeout",
  "ETIMEDOUT",
  "ECONNRESET",
];

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) =>
    lower.includes(pattern.toLowerCase())
  );
}
