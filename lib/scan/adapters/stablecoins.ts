import "server-only";

import { ethers } from "ethers";
import { decodeUint256 } from "@/lib/scan/decode-uint256";
import type {
  AdapterCallDescriptor,
  MulticallResult,
  StablecoinBalance,
} from "@/lib/scan/types";

/**
 * Minimal ERC20 balanceOf ABI fragment used to encode per-token balance reads.
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

/**
 * A token entry from the supported_tokens registry passed by the orchestrator.
 *
 * The orchestrator queries `supportedTokens WHERE chainId = ? AND isStablecoin = true`
 * and passes the result here. This adapter is pure over the provided list.
 */
export interface StablecoinToken {
  /** ERC20 contract address (lowercase). */
  tokenAddress: string;
  /** Token symbol, e.g. "USDC". */
  symbol: string;
  /** Token decimals from the registry. */
  decimals: number;
}

/**
 * Build Multicall3 aggregate3 call descriptors for stablecoin ERC20 balances.
 *
 * Produces one `balanceOf(userAddress)` call per token in `tokens`, all with
 * `allowFailure: true`. The call order matches the token array order so that
 * `decodeStablecoinResults` can align results by index.
 *
 * The token list is sourced by the orchestrator from the supported_tokens
 * registry (chainId + isStablecoin filter); this function is pure over it.
 */
export function buildStablecoinCalls(
  userAddress: string,
  tokens: StablecoinToken[]
): AdapterCallDescriptor[] {
  const calls: AdapterCallDescriptor[] = [];
  for (const token of tokens) {
    calls.push({
      target: token.tokenAddress,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData("balanceOf", [userAddress]),
    });
  }
  return calls;
}

/**
 * Decode aggregate3 results for stablecoin ERC20 balances.
 *
 * `results` must be aligned 1:1 with `tokens` (same order as returned by
 * `buildStablecoinCalls`). For each result:
 *   - `success: false` → skip (soft miss, SCAN-06)
 *   - zero balance → skip
 *   - non-zero balance → emit StablecoinBalance with:
 *       amount:    stringified bigint base units (never JS number — T-51-06-01)
 *       decimals:  from registry (not assumed)
 *       usdValue:  null (orchestrator applies pricing from Plan 04)
 *       priceUsd:  null (orchestrator applies Chainlink/DefiLlama)
 *       depegged:  false (orchestrator applies depeg check after pricing)
 *
 * Does not throw on decode failure — returns an empty array instead.
 */
export function decodeStablecoinResults(
  results: MulticallResult[],
  tokens: StablecoinToken[],
  chainId: number
): StablecoinBalance[] {
  const stablecoins: StablecoinBalance[] = [];

  for (const [i, result] of results.entries()) {
    const token = tokens[i];

    if (!token) {
      continue;
    }

    if (!result.success) {
      // Soft miss — skip this token, continue with the rest.
      continue;
    }

    const balance = decodeUint256(result.returnData);
    if (balance === null || balance === BigInt(0)) {
      continue;
    }

    stablecoins.push({
      chainId,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      amount: String(balance),
      decimals: token.decimals,
      usdValue: null,
      priceUsd: null,
      depegged: false,
    });
  }

  return stablecoins;
}
