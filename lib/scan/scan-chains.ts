import "server-only";

import { sanitizeRpcError } from "@/lib/rpc/sanitize-rpc-error";
import type { ChainScanOutput, UnavailableChain } from "@/lib/scan/types";

/** Per-chain wall-clock timeout in milliseconds (SCAN-08). */
const CHAIN_TIMEOUT_MS = 4000;

/**
 * Wrap a single-chain scan in a 4s AbortController timeout.
 *
 * Uses `Promise.race` against a rejection that fires when the controller
 * aborts, giving the outer fan-out a bounded wall-clock guarantee without
 * blocking other chains. `clearTimeout` runs in `finally` so the timer is
 * always cleaned up regardless of which branch wins the race.
 */
async function scanWithTimeout(
  chainId: number,
  scanOneChain: (chainId: number) => Promise<ChainScanOutput>
): Promise<ChainScanOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CHAIN_TIMEOUT_MS);

  try {
    const timeoutRace = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(
          new Error(
            `Chain ${chainId} scan timed out after ${CHAIN_TIMEOUT_MS}ms`
          )
        );
      });
    });
    return await Promise.race([scanOneChain(chainId), timeoutRace]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan out a scan across multiple chains with per-chain isolation.
 *
 * Each chain is wrapped in a 4s `AbortController` timeout. `Promise.allSettled`
 * ensures every chain is attempted regardless of individual success or failure.
 * A slow or erroring chain produces an entry in `unavailableChains[]` with a
 * scrubbed reason string (RPC URLs and API keys removed via `sanitizeRpcError`).
 * This function never throws — partial results are a first-class state (SCAN-08).
 *
 * @param chainIds    The chain IDs to scan in parallel.
 * @param scanOneChain A callback that scans a single chain and returns its output.
 * @returns           Fulfilled outputs and markers for chains that could not be scanned.
 */
export async function scanChains(
  chainIds: number[],
  scanOneChain: (chainId: number) => Promise<ChainScanOutput>
): Promise<{
  chainOutputs: ChainScanOutput[];
  unavailableChains: UnavailableChain[];
}> {
  const settled = await Promise.allSettled(
    chainIds.map((chainId) => scanWithTimeout(chainId, scanOneChain))
  );

  const chainOutputs: ChainScanOutput[] = [];
  const unavailableChains: UnavailableChain[] = [];

  const pairs = chainIds.map((chainId, i) => ({
    chainId,
    result: settled[i],
  }));

  for (const { chainId, result } of pairs) {
    if (result === undefined) {
      continue;
    }
    if (result.status === "fulfilled") {
      chainOutputs.push(result.value);
    } else {
      const { message } = sanitizeRpcError(result.reason);
      unavailableChains.push({ chainId, reason: message });
    }
  }

  return { chainOutputs, unavailableChains };
}
