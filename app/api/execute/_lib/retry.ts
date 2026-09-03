import "server-only";

import type { RetryConfig } from "./types";

const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The shape the web3 step cores actually return. The failure branch carries a
 * `transactionHash` whenever the send reached the chain but its outcome could
 * not be read - see the OnChainPendingError path in
 * lib/web3/chain-adapter/evm.ts and its handling in
 * plugins/web3/steps/write-contract-core.ts - and an `errorClass` alongside it.
 * Modelling that hash is what lets the retry gate below see a live
 * transaction instead of only a string.
 */
export type TransactionResult =
  | { success: true; transactionHash: string; [key: string]: unknown }
  | {
      success: false;
      error: string;
      transactionHash?: string;
      [key: string]: unknown;
    };

type ExecuteFn<T> = () => Promise<T>;

/**
 * Determines whether a result represents a successful execution.
 * Return true to stop retrying, false to retry (if attempts remain).
 */
type SuccessPredicate<T> = (result: T) => boolean;

/**
 * Extracts an error message from a failed result for retryability checks.
 * Return undefined to make the result non-retryable, either because it has no
 * extractable error string or because the extractor knows a retry is unsafe.
 */
type ErrorExtractor<T> = (result: T) => string | undefined;

function resolveConfig(config?: RetryConfig): Required<RetryConfig> {
  return {
    maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

/**
 * A failure carrying a transaction hash is never retryable, whatever it says.
 * The hash is proof that a transaction is live: it was broadcast and either
 * reverted or could not be read back. A retry cannot replace it - nothing is
 * pinned, so the next attempt signs an independent transaction at the next
 * nonce - so the hash decides this, not the error text. Withholding the string
 * is what makes the result non-retryable; it is still carried on the `failed`
 * outcome, and the node route reads the hash off it.
 */
const TX_ERROR: ErrorExtractor<TransactionResult> = (r) => {
  if (r.success) {
    return;
  }
  if (typeof r.transactionHash === "string" && r.transactionHash !== "") {
    return;
  }
  return r.error;
};

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
 * Execute a function with automatic retry.
 *
 * A retry re-runs executeFn from scratch. It is not a replacement transaction:
 * nothing is pinned, so a web3 step that retries opens a new nonce session and
 * signs an independent transaction at the next nonce. Retries are therefore
 * only safe when the previous attempt is known not to have broadcast.
 *
 * Two things decide that, in order. The guarantee is the hash gate in TX_ERROR
 * above: a returned failure carrying a transaction hash is never retried, so
 * an outcome the step could not read back cannot be sent twice. The string
 * list below is a secondary filter over the failures that carry no hash, and
 * it is a heuristic - it can only ever say which error texts look like a send
 * that did not happen.
 *
 * Neither covers the timeout path, which the caller carries: on timeout the
 * in-flight executeFn promise is abandoned but not cancelled, so no result and
 * no hash ever come back, and a transaction it already broadcast can still
 * confirm. A timeoutMs below the chain's confirmation latency can therefore
 * produce two confirmed transactions. Set timeoutMs above the confirmation
 * latency of the target chain.
 */
export async function executeWithRetry<T>(
  executeFn: ExecuteFn<T>,
  config: RetryConfig | undefined,
  options: RetryOptions<T>
): Promise<RetryResult<T>> {
  const resolved = resolveConfig(config);
  let retryCount = 0;

  for (let attempt = 0; attempt <= resolved.maxRetries; attempt++) {
    const resultOrTimeout = await withTimeout(executeFn(), resolved.timeoutMs);

    if (resultOrTimeout === "timeout") {
      if (attempt >= resolved.maxRetries) {
        return {
          outcome: "timeout",
          error: `Timed out after ${resolved.maxRetries} retries`,
          retryCount,
        };
      }
      retryCount++;
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
  }

  return {
    outcome: "exhausted",
    error: "Max retries exceeded",
    retryCount,
  };
}

/**
 * Consulted only for failures that carry no transaction hash, so it is a
 * filter and not the guarantee - the hash gate in TX_ERROR is. A retry signs a
 * fresh transaction at the next nonce, so nothing whose text implies a
 * broadcast already happened may be listed here. That rules out the nonce
 * conflicts enumerated in NONCE_CONFLICT_MESSAGE_PATTERNS
 * (lib/web3/submit-signed.ts), which is the canonical set: "nonce has already
 * been used", "already known" and "replacement fee too low" were listed here
 * and are gone. Bare "transaction underpriced" was also listed and is also
 * gone, for a different reason - it is the pool rejecting a fee below its
 * minimum, so nothing is live, but with no gas bump a retry re-sends the same
 * fee and fails identically. Only the "replacement transaction underpriced"
 * variant reports a broadcast.
 */
const RETRYABLE_PATTERNS = ["timeout", "ETIMEDOUT", "ECONNRESET"];

function isRetryableError(error: string): boolean {
  const lower = error.toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) =>
    lower.includes(pattern.toLowerCase())
  );
}
