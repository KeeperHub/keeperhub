import "server-only";

import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { rawToUi, resolveForDisplay } from "@/lib/web3/ui-multiplier";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";
import {
  getTokenAddress,
  parseTokenConfig,
  type TokenBalanceInfo,
  type TokenConfigSource,
} from "./token-config-core";

type CheckTokenBalanceResult =
  | {
      success: true;
      balance: TokenBalanceInfo;
      address: string;
      addressLink: string;
    }
  | { success: false; error: string };

export type CheckTokenBalanceCoreInput = TokenConfigSource & {
  network: string;
  address: string;
};

export type CheckTokenBalanceInput = StepInput & CheckTokenBalanceCoreInput;

/**
 * Fetch a string metadata field from a token contract, handling non-standard
 * tokens (e.g. MKR, DAI v1) that return bytes32 instead of string.
 */
async function fetchStringOrBytes32(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  method: "symbol" | "name"
): Promise<string> {
  const iface = new ethers.Interface([
    `function ${method}() view returns (string)`,
  ]);
  const data = iface.encodeFunctionData(method);
  const result = await provider.call({ to: tokenAddress, data });

  try {
    const decoded = iface.decodeFunctionResult(method, result);
    return decoded[0] as string;
  } catch {
    // Non-standard token returning bytes32 (e.g. MKR, DAI v1)
    try {
      return ethers.decodeBytes32String(result);
    } catch {
      return method === "symbol" ? "???" : "Unknown";
    }
  }
}

/**
 * Fetch balance for a single token
 */
async function fetchTokenBalance(
  provider: ethers.JsonRpcProvider,
  walletAddress: string,
  tokenAddress: string,
  uiMultiplier: bigint
): Promise<TokenBalanceInfo> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [balanceRaw, decimals, symbol, name] = await Promise.all([
    contract.balanceOf(walletAddress) as Promise<bigint>,
    contract.decimals() as Promise<bigint>,
    fetchStringOrBytes32(provider, tokenAddress, "symbol"),
    fetchStringOrBytes32(provider, tokenAddress, "name"),
  ]);

  const decimalsNum = Number(decimals);
  // On an ERC-8056 token the holder is shown the scaled balance, so report
  // that. `balanceRaw` stays the unscaled on-chain value it has always been:
  // it is what a transfer moves, and a caller comparing it against an explorer
  // needs it to keep meaning the same thing.
  const balance = ethers.formatUnits(
    rawToUi(balanceRaw, uiMultiplier),
    decimalsNum
  );

  return {
    balance,
    balanceRaw: balanceRaw.toString(),
    symbol,
    decimals: decimalsNum,
    name,
    tokenAddress: tokenAddress.toLowerCase(),
  };
}

/**
 * Resolve an RPC provider and read the ERC20 balance/metadata.
 */
async function checkEvmTokenBalance(
  address: string,
  tokenAddress: string,
  chainId: number,
  userId: string | undefined
): Promise<CheckTokenBalanceResult> {
  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Token Balance] Failed to resolve RPC config:",
      error,
      {
        plugin_name: "web3",
        action_name: "check-token-balance",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  const adapter = getChainAdapter(chainId);

  try {
    // Resolved through failover in its own right, rather than pinned to the
    // single provider the balance read happens to land on. A multiplier read
    // that quietly failed while the balance succeeded on a retry would report
    // a scaled token's balance understated, as a success.
    const uiMultiplier = await resolveForDisplay(
      (op) => adapter.executeWithFailover(rpcManager, op),
      chainId,
      tokenAddress
    );
    const balance = await adapter.executeWithFailover(
      rpcManager,
      async (provider) =>
        fetchTokenBalance(provider, address, tokenAddress, uiMultiplier)
    );
    const addressLink = await adapter.getAddressUrl(address);

    return { success: true, balance, address, addressLink };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Check Token Balance] Failed to check token balance:",
      error,
      {
        plugin_name: "web3",
        action_name: "check-token-balance",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: `Failed to check token balance: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Core check token balance logic
 */
async function stepHandler(
  input: CheckTokenBalanceInput
): Promise<CheckTokenBalanceResult> {
  console.log("[Check Token Balance] Starting step with input:", {
    network: input.network,
    address: input.address,
    tokenConfig: input.tokenConfig,
    executionId: input._context?.executionId,
  });

  const { network, address, _context } = input;
  const tokenConfig = parseTokenConfig(input);

  // Get userId from execution context (for user RPC preferences)
  const userId = await getRpcPreferenceUserId(_context?.executionId);
  if (userId) {
    console.log(
      "[Check Token Balance] Using user RPC preferences for userId:",
      userId
    );
  }

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    console.log("[Check Token Balance] Resolved chain ID:", chainId);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Token Balance] Failed to resolve network:",
      error,
      {
        plugin_name: "web3",
        action_name: "check-token-balance",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  if (isSolanaChain(chainId)) {
    return {
      success: false,
      error:
        "Solana chains are not supported by this action. Use the Get SPL Token Balance action for SPL tokens.",
    };
  }

  // Validate wallet address
  if (!validateChainAddress(address, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Token Balance] Invalid wallet address:",
      address,
      {
        plugin_name: "web3",
        action_name: "check-token-balance",
      }
    );
    return {
      success: false,
      error: `Invalid wallet address: ${address}`,
    };
  }

  // Get token address to check
  const tokenAddress = await getTokenAddress(tokenConfig, chainId);

  if (!tokenAddress) {
    return {
      success: false,
      error: "No token selected to check",
    };
  }

  console.log(
    "[Check Token Balance] Checking balance for token:",
    tokenAddress
  );

  // Validate token address
  if (!validateChainAddress(tokenAddress, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Token Balance] Invalid token address:",
      tokenAddress,
      {
        plugin_name: "web3",
        action_name: "check-token-balance",
      }
    );
    return {
      success: false,
      error: `Invalid token address: ${tokenAddress}`,
    };
  }

  return checkEvmTokenBalance(address, tokenAddress, chainId, userId);
}

/**
 * Check Token Balance Step
 * Checks the ERC20 token balance of an address for a single token
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function checkTokenBalanceStep(
  input: CheckTokenBalanceInput
): Promise<CheckTokenBalanceResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "check-token-balance" },
    input,
    stepHandler
  );
}

checkTokenBalanceStep.maxRetries = 0;

export const _integrationType = "web3";
