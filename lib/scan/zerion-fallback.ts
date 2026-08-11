import "server-only";

import type { ProtocolPosition } from "@/lib/scan/types";

/**
 * Returns true when the ZERION_API_KEY environment variable is set.
 *
 * Used by the scanner orchestrator to decide whether to attempt the Zerion
 * breadth fallback. The key is not validated here — Phase 52 validates it at
 * call time. When absent, the scanner degrades to native-only (Aave V3 +
 * Lido + stablecoins) without throwing (SCAN-12).
 */
export function isZerionEnabled(): boolean {
  return Boolean(process.env.ZERION_API_KEY);
}

/**
 * Attempts to fetch additional portfolio positions from the Zerion API.
 *
 * Phase 51 (native-only): always returns [] — no REST call is made
 * regardless of whether ZERION_API_KEY is set. The key-presence check is
 * wired so that Phase 52 can add the real HTTP call without structural
 * changes to the orchestrator.
 *
 * Merge semantics: the scanner merges Zerion positions with native positions
 * using native-takes-precedence by (protocol, chainId). In Phase 51 the
 * merge is a no-op since this function returns [].
 *
 * Never throws when ZERION_API_KEY is absent or the API is unavailable.
 *
 * Phase 52: implement Zerion REST breadth fallback here
 */
export function maybeZerionFallback(
  _address: string,
  _chainIds: number[]
): Promise<ProtocolPosition[]> {
  if (!isZerionEnabled()) {
    return Promise.resolve([]);
  }

  // Phase 52: implement Zerion REST breadth fallback here
  // When implemented: call the Zerion portfolio positions endpoint, normalise
  // response to ProtocolPosition[], and merge with native positions so that
  // native positions take precedence for the same (protocol, chainId) pair.
  return Promise.resolve([]);
}
