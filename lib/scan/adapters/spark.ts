import "server-only";

import { ethers } from "ethers";
import AAVE_V3_POOL_ABI from "@/lib/scan/abis/aave-v3-pool.json";
import { decodeAaveV3Results } from "@/lib/scan/adapters/aave-v3";
import { SPARK_POOLS } from "@/lib/scan/adapters/protocol-registry";
import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * SparkLend Pool interface — identical ABI to Aave V3 Pool
 * (getUserAccountData + getUserEMode wire format, verified 56-RESEARCH Q3).
 */
const sparkPoolIface = new ethers.Interface(
  AAVE_V3_POOL_ABI as unknown as ethers.InterfaceAbi
);

/**
 * Build Multicall3 aggregate3 call descriptors for SparkLend position data.
 *
 * SparkLend is a direct Aave V3 fork — the Pool at SPARK_POOLS[chainId]
 * exposes the identical getUserAccountData + getUserEMode interface.
 *
 * Returns an empty array when the chain has no registered SparkLend Pool.
 */
export function buildSparkCalls(
  userAddress: string,
  chainId: number
): AdapterCallDescriptor[] {
  const poolAddress = SPARK_POOLS[chainId];
  if (!poolAddress) {
    return [];
  }
  return [
    {
      target: poolAddress,
      allowFailure: true,
      callData: sparkPoolIface.encodeFunctionData("getUserAccountData", [
        userAddress,
      ]),
    },
    {
      target: poolAddress,
      allowFailure: true,
      callData: sparkPoolIface.encodeFunctionData("getUserEMode", [
        userAddress,
      ]),
    },
  ];
}

/**
 * Decode aggregate3 results for SparkLend position data.
 *
 * Thin wrapper over decodeAaveV3Results: SparkLend Pool exposes the identical
 * getUserAccountData + getUserEMode wire format. Remaps protocol to "spark"
 * so callers can distinguish SparkLend from Aave V3 positions.
 *
 * MAX_UINT256 guard, normalizeHealthFactor, and eMode soft-miss stay
 * single-sourced in aave-v3.ts — no logic is duplicated here.
 */
export function decodeSparkResults(
  results: MulticallResult[],
  address: string,
  chainId: number
): ProtocolPosition[] {
  return decodeAaveV3Results(results, address, chainId).map((p) => ({
    ...p,
    protocol: "spark" as const,
  }));
}
