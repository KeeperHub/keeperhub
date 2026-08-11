import "server-only";

import { ethers } from "ethers";
import type { AdapterCallDescriptor } from "@/lib/scan/types";
import { AGGREGATOR_V3_ABI } from "@/lib/web3/chainlink-feeds";

/**
 * Minimum USD price deviation from $1.00 that flags a stablecoin as depegged.
 * 0.005 = 0.5%.  Deviation is inclusive: |price - 1.0| >= DEPEG_THRESHOLD.
 *
 * Reference: CONTEXT.md "deviation >= 0.5% from $1.00 flags depegged: true"
 */
export const DEPEG_THRESHOLD = 0.005;

/**
 * Module-level Chainlink aggregator interface. Constructed once and reused
 * across every encode/decode call rather than per-invocation, matching the
 * adapter convention elsewhere in lib/scan.
 */
const AGGREGATOR_V3_IFACE = new ethers.Interface(
  AGGREGATOR_V3_ABI as unknown as ethers.InterfaceAbi
);

/**
 * Returns true when a stablecoin's USD price deviates >= 0.5% from $1.00.
 *
 * - price < $0.995  → true  (depeg below peg)
 * - price > $1.005  → true  (depeg above peg)
 * - $0.995 ≤ price ≤ $1.005 → false
 *
 * Stablecoins are NEVER priced at a hardcoded $1.00.  Always pass the
 * Chainlink latestRoundData price into this function (SCAN-10).
 */
export function isDepegged(price: number): boolean {
  return Math.abs(price - 1.0) >= DEPEG_THRESHOLD;
}

/**
 * Builds the Multicall3 AdapterCallDescriptor for a Chainlink
 * latestRoundData call on the given aggregator feed proxy address.
 *
 * The returned descriptor is meant to be batched into an aggregate3 call
 * by the scanner orchestrator — not executed directly.
 */
export function readChainlinkPrice(feedAddress: string): AdapterCallDescriptor {
  return {
    target: feedAddress,
    allowFailure: true,
    callData: AGGREGATOR_V3_IFACE.encodeFunctionData("latestRoundData", []),
  };
}

/**
 * Decodes the ABI-encoded returnData from a Chainlink latestRoundData
 * aggregate3 sub-call into a USD price as a JavaScript number.
 *
 * Returns null when:
 *   - the answer is zero or negative (feed not yet reporting, or a bad price)
 *   - returnData cannot be decoded (call failed, empty bytes)
 *
 * Never returns $0 as a guess — callers must treat null as "N/A" (SCAN-09).
 *
 * @param returnData - ABI-encoded hex bytes from the aggregate3 sub-call result
 * @param decimals   - Feed decimal places; Chainlink USD feeds use 8 decimals
 */
export function decodeChainlinkAnswer(
  returnData: string,
  decimals = 8
): number | null {
  try {
    const decoded = AGGREGATOR_V3_IFACE.decodeFunctionResult(
      "latestRoundData",
      returnData
    );
    // decoded[1] is the `answer` field (int256); ethers v6 decodes int256 as bigint
    const answer = decoded[1] as bigint;
    if (answer <= BigInt(0)) {
      return null;
    }
    return Number(answer) / 10 ** decimals;
  } catch {
    return null;
  }
}
