import "server-only";

import { ethers } from "ethers";
import ERC4626_SAVINGS_ABI from "@/lib/scan/abis/erc4626-savings.json";
import { SKY_SAVINGS } from "@/lib/scan/adapters/protocol-registry";
import { decodeUint256 } from "@/lib/scan/decode-uint256";
import type {
  AdapterCallDescriptor,
  MulticallResult,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * sUSDS ERC-4626 vault interface — provides balanceOf (shares) and
 * maxWithdraw (USDS underlying for pricing in scanOneChain).
 */
const savingsIface = new ethers.Interface(
  ERC4626_SAVINGS_ABI as unknown as ethers.InterfaceAbi
);

/**
 * Build Multicall3 aggregate3 call descriptors for Sky savings balances.
 *
 * Encodes two independent reads against the sUSDS ERC-4626 vault:
 *   [0] balanceOf(account)   -> shares balance (for displayed amount)
 *   [1] maxWithdraw(account) -> USDS underlying (for USD pricing in scanOneChain)
 *
 * Returns an empty array when the chain has no registered SKY_SAVINGS entry.
 */
export function buildSkyCalls(
  userAddress: string,
  chainId: number
): AdapterCallDescriptor[] {
  const savings = SKY_SAVINGS[chainId];
  if (!savings) {
    return [];
  }
  return [
    {
      target: savings.sUSDS,
      allowFailure: true,
      callData: savingsIface.encodeFunctionData("balanceOf", [userAddress]),
    },
    {
      target: savings.sUSDS,
      allowFailure: true,
      callData: savingsIface.encodeFunctionData("maxWithdraw", [userAddress]),
    },
  ];
}

/**
 * Decode aggregate3 results for Sky savings balances.
 *
 * Returns a single ProtocolPosition with protocol "sky", healthFactor null,
 * noActiveLoan true, and suppliedAssets[0] = { symbol: "sUSDS", amount: shares,
 * decimals: 18, usdValue: null }. usdValue is filled by scanOneChain after
 * pricing via resolveUsdPrice (USDS -> DefiLlama fallback).
 *
 * Returns an empty array when balanceOf is zero or the call failed (soft-miss).
 */
export function decodeSkyResults(
  results: MulticallResult[],
  _address: string,
  chainId: number
): ProtocolPosition[] {
  const savings = SKY_SAVINGS[chainId];
  if (!savings) {
    return [];
  }

  const balanceOfResult = results[0];
  if (!balanceOfResult?.success) {
    return [];
  }

  const shares = decodeUint256(balanceOfResult.returnData);
  if (shares === null || shares <= BigInt(0)) {
    return [];
  }

  return [
    {
      chainId,
      protocol: "sky",
      healthFactor: null,
      noActiveLoan: true,
      totalCollateralUsd: null,
      totalDebtUsd: null,
      suppliedAssets: [
        {
          symbol: "sUSDS",
          tokenAddress: savings.sUSDS,
          amount: String(shares),
          decimals: 18,
          usdValue: null,
        },
      ],
      borrowedAssets: [],
    },
  ];
}
