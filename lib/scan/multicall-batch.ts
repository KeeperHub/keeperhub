import "server-only";

import { ethers } from "ethers";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "@/lib/contracts/multicall3";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import type { AdapterCallDescriptor, MulticallResult } from "@/lib/scan/types";

/** Maximum number of sub-calls per aggregate3 batch round-trip (SCAN-06 cap). */
const BATCH_SIZE = 20;

/**
 * Execute an ordered list of Multicall3 aggregate3 sub-calls against a
 * single chain's RPC manager.
 *
 * Slices `calls` into chunks of at most `BATCH_SIZE` to stay within safe
 * payload limits. Every call descriptor must carry `allowFailure: true`; a
 * failed sub-call returns `{ success: false, returnData: "0x" }` without
 * aborting its siblings (soft-miss semantics — SCAN-06).
 *
 * Results are concatenated in input order so callers can align them 1:1
 * with the original call list by index.
 */
export async function executeMulticallBatch(
  calls: AdapterCallDescriptor[],
  rpcManager: RpcProviderManager
): Promise<MulticallResult[]> {
  const results: MulticallResult[] = [];

  // Slice into at-most-BATCH_SIZE chunks without an indexed for loop.
  const chunks: AdapterCallDescriptor[][] = [];
  let remaining: AdapterCallDescriptor[] = calls;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, BATCH_SIZE));
    remaining = remaining.slice(BATCH_SIZE);
  }

  for (const chunk of chunks) {
    const batchResults = await rpcManager.executeWithFailover(
      (provider: ethers.JsonRpcProvider) => {
        const multicall = new ethers.Contract(
          MULTICALL3_ADDRESS,
          MULTICALL3_ABI,
          provider
        );
        return multicall.aggregate3.staticCall(chunk) as Promise<
          [boolean, string][]
        >;
      }
    );

    for (const [success, returnData] of batchResults) {
      results.push({ success, returnData });
    }
  }

  return results;
}
