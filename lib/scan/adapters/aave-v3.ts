import "server-only";

import { ethers } from "ethers";
import AAVE_V3_POOL_ABI from "@/lib/scan/abis/aave-v3-pool.json";
import { AAVE_V3_POOLS } from "@/lib/scan/adapters/protocol-registry";
import { decodeUint256 } from "@/lib/scan/decode-uint256";
import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * MAX_UINT256: type(uint256).max, the sentinel Aave V3 returns in
 * GenericLogic.sol when totalDebtInBaseCurrency == 0.
 *
 * Uses BigInt() constructor — tsconfig target ES2017 does not support
 * the n-suffix literal syntax (requires ES2020).
 */
const MAX_UINT256 = BigInt(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

// biome-ignore lint/suspicious/noExplicitAny: JSON import typed as any by TypeScript
const poolIface = new ethers.Interface(AAVE_V3_POOL_ABI as unknown as any[]);

/**
 * Build Multicall3 aggregate3 call descriptors for Aave V3 position data.
 *
 * Encodes two calls in order:
 *   [0] getUserAccountData(user) -> 6x uint256 (flat, no nested tuples)
 *   [1] getUserEMode(user)       -> uint256 eMode category
 *
 * IMPORTANT: Do NOT use PoolDataProvider reserve-data functions —
 * those return nested tuples that cause ethers v6 decode failures.
 *
 * Returns an empty array when the chain has no registered Aave V3 Pool.
 */
export function buildAaveV3Calls(
  userAddress: string,
  chainId: number
): AdapterCallDescriptor[] {
  const poolAddress = AAVE_V3_POOLS[chainId];
  if (!poolAddress) {
    return [];
  }
  return [
    {
      target: poolAddress,
      allowFailure: true,
      callData: poolIface.encodeFunctionData("getUserAccountData", [
        userAddress,
      ]),
    },
    {
      target: poolAddress,
      allowFailure: true,
      callData: poolIface.encodeFunctionData("getUserEMode", [userAddress]),
    },
  ];
}

/**
 * Guard for Aave V3 health factor (SCAN-05).
 *
 * Aave V3 GenericLogic.sol sets healthFactor = type(uint256).max when
 * totalDebtInBaseCurrency == 0. The guard checks both conditions:
 *   - totalDebtBase === 0n  -> no loan exists (belt-and-suspenders)
 *   - rawHf === MAX_UINT256 -> contract sentinel for no-debt state
 *
 * Returns null when either condition is true (noActiveLoan: true).
 * Otherwise converts from WAD (1e18 = 1.0) to a 4-decimal float.
 */
export function normalizeHealthFactor(
  rawHf: bigint,
  totalDebtBase: bigint
): number | null {
  const noDebt = totalDebtBase === BigInt(0);
  const infiniteHf = rawHf === MAX_UINT256;
  if (noDebt || infiniteHf) {
    return null;
  }
  // Pitfall 5: precision loss beyond ~15 significant digits is acceptable
  // for the 4-decimal display value. Raw bigint is never emitted.
  return Number.parseFloat((Number(rawHf) / 1e18).toFixed(4));
}

/**
 * Decode aggregate3 results for Aave V3 position data.
 *
 * `results` must be aligned as [getUserAccountData, getUserEMode], matching
 * the call order returned by buildAaveV3Calls.
 *
 * Returns an empty array when:
 *   - the getUserAccountData sub-call failed (success: false)
 *   - both totalCollateralBase and totalDebtBase are zero (no position)
 *
 * Aave V3 base units for USD values are 8 decimals (divide by 1e8).
 * suppliedAssets and borrowedAssets are left empty in Phase 51 — populated
 * by the pricing + reserve-data layer in Phase 52.
 */
export function decodeAaveV3Results(
  results: MulticallResult[],
  _address: string,
  chainId: number
): ProtocolPosition[] {
  const accountResult = results[0];
  const eModeResult = results[1];

  if (
    !(accountResult?.success && accountResult.returnData) ||
    accountResult.returnData === "0x"
  ) {
    return [];
  }

  let decoded: ethers.Result;
  try {
    decoded = poolIface.decodeFunctionResult(
      "getUserAccountData",
      accountResult.returnData
    );
  } catch {
    return [];
  }

  const totalCollateralBase = decoded.totalCollateralBase as bigint;
  const totalDebtBase = decoded.totalDebtBase as bigint;
  const rawHealthFactor = decoded.healthFactor as bigint;

  // No position at all — address has never interacted with this Aave V3 pool.
  if (totalCollateralBase === BigInt(0) && totalDebtBase === BigInt(0)) {
    return [];
  }

  const noDebt = totalDebtBase === BigInt(0);
  const infiniteHf = rawHealthFactor === MAX_UINT256;
  const noActiveLoan = noDebt || infiniteHf;
  const healthFactor = normalizeHealthFactor(rawHealthFactor, totalDebtBase);

  // Decode eMode category (0 = no eMode). Soft-miss: default to 0 on failure.
  let emodeCategory = 0;
  if (eModeResult?.success) {
    const eMode = decodeUint256(eModeResult.returnData);
    if (eMode !== null) {
      emodeCategory = Number(eMode);
    }
  }

  const position: ProtocolPosition = {
    chainId,
    protocol: "aave-v3",
    healthFactor,
    totalCollateralUsd: Number(totalCollateralBase) / 1e8,
    totalDebtUsd: Number(totalDebtBase) / 1e8,
    emodeCategory,
    suppliedAssets: [],
    borrowedAssets: [],
  };

  if (noActiveLoan) {
    position.noActiveLoan = true;
  }

  return [position];
}
