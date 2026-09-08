/**
 * Shared RPC-resilience helpers for the protocol on-chain integration tests.
 *
 * These tests make real `eth_call`s against deployed mainnet contracts to
 * prove our ABI-driven calldata matches the deployed bytecode. Their value
 * is catching ABI/dispatch regressions - not measuring the uptime of a busy
 * RPC endpoint. But a live call can fail for two very different reasons:
 *
 *   1. The deployed bytecode rejected our calldata (real regression) -
 *      surfaces as an ABI/decode error (BAD_DATA, INVALID_ARGUMENT,
 *      BUFFER_OVERRUN) or a revert that carries data. These MUST fail
 *      immediately.
 *   2. The RPC endpoint could not service the call - rate limiting (429), a
 *      node error, a timeout, a dropped connection, or an `eth_call` that
 *      came back with no execution data at all ("missing revert data").
 *      These are transient infrastructure faults, not code defects.
 *
 * `isRpcInfraError` classifies (2). `itOnchain` runs an on-chain test body
 * and, when it fails with an infra fault, retries with exponential backoff
 * (which lets a rate-limit window reset) before giving up. The test still
 * fails if the fault persists across every attempt - we do not skip or
 * swallow it - and a real assertion or ABI/decode failure fails on the first
 * attempt with no retry.
 */

import { it } from "vitest";

interface EthersLikeError {
  code?: string;
  data?: unknown;
  reason?: unknown;
}

function asEthersError(err: unknown): EthersLikeError | null {
  if (typeof err === "object" && err !== null) {
    return err as EthersLikeError;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : "";
}

// ethers v6 error codes for anything that is not the contract itself
// responding: network drop, HTTP error (rate-limit 429, 5xx), timeout, or a
// generic JSON-RPC error passthrough.
const NETWORK_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "TIMEOUT",
  "UNKNOWN_ERROR",
]);

// RpcProviderManager.executeWithFailover rethrows transport failures wrapped
// in a plain Error that drops the ethers `code`, so we also match on the
// wrapper prefixes and the underlying connection strings it carries. Keep in
// sync with lib/rpc/providers RPC_CONNECTION_ERROR_PATTERNS and the throw
// sites there.
const TRANSPORT_MESSAGE_MARKERS: readonly string[] = [
  "RPC failed on both endpoints",
  "RPC failed on primary endpoint",
  "Timeout after ",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "fetch failed",
];

/**
 * True for transport/endpoint faults that mean the RPC could not service the
 * request, whether the raw ethers error surfaced (has a `code`) or the
 * failover manager wrapped it in a message-only Error.
 */
export function isRpcNetworkError(err: unknown): boolean {
  const e = asEthersError(err);
  if (e?.code && NETWORK_ERROR_CODES.has(e.code)) {
    return true;
  }
  const msg = messageOf(err);
  return TRANSPORT_MESSAGE_MARKERS.some((marker) => msg.includes(marker));
}

/**
 * True for any RPC-infrastructure fault worth retrying an on-chain read on.
 * Superset of `isRpcNetworkError` that also covers a `CALL_EXCEPTION` with no
 * execution data ("missing revert data"): a plain view function on a
 * known-good contract does not revert, so a data-less call exception here
 * means the endpoint returned an error rather than the contract rejecting the
 * calldata. A genuine ABI mismatch surfaces instead as BAD_DATA /
 * INVALID_ARGUMENT / BUFFER_OVERRUN, or as a revert carrying data - none of
 * which match here, so those fail immediately without retry.
 */
export function isRpcInfraError(err: unknown): boolean {
  if (isRpcNetworkError(err)) {
    return true;
  }
  const e = asEthersError(err);
  if (!e) {
    return false;
  }
  return e.code === "CALL_EXCEPTION" && e.data == null && e.reason == null;
}

// Retry policy for infra faults. Delays are 750ms, 1.5s, 3s between the four
// attempts - enough for a provider's per-second rate-limit window to reset
// without stretching a healthy test.
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 750;
// Headroom added to each test's own timeout to cover the retry backoff so a
// retried-but-healthy test does not trip the per-test deadline.
const RETRY_BUDGET_MS = 30_000;
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type OnchainBody = () => Promise<void> | void;

/**
 * `it` for on-chain tests that hit a live RPC. A transient RPC-infrastructure
 * fault is retried with exponential backoff so a rate-limited or briefly
 * unreachable endpoint does not flake the suite. A real assertion or
 * ABI/decode failure fails on the first attempt, and an infra fault that
 * persists across every attempt still fails the test - nothing is skipped.
 */
export function itOnchain(
  name: string,
  body: OnchainBody,
  timeout?: number
): void {
  it(
    name,
    async () => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await body();
          return;
        } catch (err) {
          lastErr = err;
          if (!isRpcInfraError(err) || attempt === MAX_ATTEMPTS) {
            throw err;
          }
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
      throw lastErr;
    },
    (timeout ?? DEFAULT_TEST_TIMEOUT_MS) + RETRY_BUDGET_MS
  );
}
