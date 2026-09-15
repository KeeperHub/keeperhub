import "server-only";

import { ethers } from "ethers";
import LIDO_WSTETH_ABI from "@/lib/scan/abis/lido-wsteth.json";
import { LIDO_TOKENS } from "@/lib/scan/adapters/protocol-registry";
import { decodeUint256 } from "@/lib/scan/decode-uint256";
import type {
  AdapterCallDescriptor,
  MulticallResult,
  PositionAsset,
  ProtocolPosition,
} from "@/lib/scan/types";

/**
 * Minimal ERC20 balanceOf ABI fragment used for encoding balanceOf calls.
 * Shared between stETH and wstETH — both implement standard ERC20.
 */
const ERC20_BALANCE_OF_FRAGMENT = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const erc20Iface = new ethers.Interface(ERC20_BALANCE_OF_FRAGMENT);

// Construct wstETH interface separately — includes getStETHByWstETH for
// Ethereum-only use (Phase 52 may add the conversion call).
// biome-ignore lint/suspicious/noExplicitAny: JSON import typed as any by TypeScript
const wstEthIface = new ethers.Interface(LIDO_WSTETH_ABI as unknown as any[]);

/**
 * Build Multicall3 aggregate3 call descriptors for Lido staking balances.
 *
 * On chains with a registered stETH contract: balanceOf for stETH and wstETH
 * (2 calls in order). On other supported chains: balanceOf for wstETH only.
 *
 * getStETHByWstETH is available on the Ethereum wstETH contract but is NOT
 * called in Phase 51 — L2 wstETH bridges may not expose this function (A6).
 *
 * Returns an empty array if the chain has no registered Lido tokens.
 */
export function buildLidoCalls(
  userAddress: string,
  chainId: number
): AdapterCallDescriptor[] {
  const tokens = LIDO_TOKENS[chainId];
  if (!tokens) {
    return [];
  }

  const calls: AdapterCallDescriptor[] = [];

  if (tokens.stETH) {
    // stETH is available on Ethereum mainnet and Hoodi. getStETHByWstETH is
    // also available on the Ethereum wstETH contract for future use.
    calls.push({
      target: tokens.stETH,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData("balanceOf", [userAddress]),
    });
  }

  calls.push({
    target: tokens.wstETH,
    allowFailure: true,
    callData: erc20Iface.encodeFunctionData("balanceOf", [userAddress]),
  });

  return calls;
}

/**
 * Decode aggregate3 results for Lido balances.
 *
 * On chains with stETH, `results` must be aligned as [stETH, wstETH]. On
 * other supported chains, `results` must be aligned as [wstETH].
 *
 * A failed sub-call (success: false) or a zero balance skips that token —
 * soft-miss semantics per SCAN-06. An empty ProtocolPosition is not emitted
 * when no non-zero balances are detected.
 *
 * Returns a single ProtocolPosition with suppliedAssets when at least one
 * balance is non-zero, or an empty array otherwise.
 */
export function decodeLidoResults(
  results: MulticallResult[],
  _address: string,
  chainId: number
): ProtocolPosition[] {
  const tokens = LIDO_TOKENS[chainId];
  if (!tokens) {
    return [];
  }

  const suppliedAssets: PositionAsset[] = [];
  let idx = 0;

  if (tokens.stETH) {
    // First result is stETH balanceOf. getStETHByWstETH is not called here —
    // raw wstETH balance only in Phase 51.
    const stEthResult = results[idx];
    idx += 1;

    if (stEthResult?.success) {
      const balance = decodeUint256(stEthResult.returnData);
      if (balance !== null && balance > BigInt(0)) {
        suppliedAssets.push({
          symbol: "stETH",
          // biome-ignore lint/style/noNonNullAssertion: guarded by tokens.stETH check above
          tokenAddress: tokens.stETH!,
          amount: String(balance),
          decimals: 18,
          usdValue: null,
        });
      }
    }
  }

  // wstETH: present on all supported chains.
  const wstEthResult = results[idx];

  if (wstEthResult?.success) {
    const balance = decodeUint256(wstEthResult.returnData);
    if (balance !== null && balance > BigInt(0)) {
      suppliedAssets.push({
        symbol: "wstETH",
        tokenAddress: tokens.wstETH,
        amount: String(balance),
        decimals: 18,
        usdValue: null,
      });
    }
  }

  if (suppliedAssets.length === 0) {
    return [];
  }

  return [
    {
      chainId,
      protocol: "lido",
      healthFactor: null,
      totalCollateralUsd: null,
      totalDebtUsd: null,
      suppliedAssets,
      borrowedAssets: [],
    },
  ];
}

// Export the wstETH interface for potential Phase 52 use (getStETHByWstETH).
// Not used in Phase 51 — L2 wstETH bridges do not expose getStETHByWstETH (A6).
export { wstEthIface };
