import "server-only";

import { and, eq } from "drizzle-orm";
import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import { supportedTokens, workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import type { CustomToken, TokenFieldValue } from "@/lib/wallet/types";
import { getChainAdapter } from "@/lib/web3/chain-adapter";

/**
 * Get userId from executionId by querying the workflowExecutions table
 */
async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

type TokenBalance = {
  balance: string;
  balanceRaw: string;
  symbol: string;
  decimals: number;
  name: string;
  tokenAddress: string;
};

type CheckTokenBalanceResult =
  | {
      success: true;
      balance: TokenBalance;
      address: string;
      addressLink: string;
    }
  | { success: false; error: string };

export type CheckTokenBalanceCoreInput = {
  network: string;
  address: string;
  tokenConfig: string | Record<string, unknown>;
  // Legacy support
  tokenAddress?: string;
};

export type CheckTokenBalanceInput = StepInput & CheckTokenBalanceCoreInput;

/**
 * Extract mode from parsed config, defaulting to "supported"
 */
function extractMode(parsed: unknown): "supported" | "custom" {
  if (typeof parsed !== "object" || parsed === null) {
    return "supported";
  }

  const config = parsed as Record<string, unknown>;
  return config.mode === "supported" || config.mode === "custom"
    ? (config.mode as "supported" | "custom")
    : "supported";
}

/**
 * Extract supported token ID from parsed config
 * Handles both new (single) and legacy (array) formats
 */
function extractSupportedTokenId(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single token ID
  if (typeof config.supportedTokenId === "string") {
    return config.supportedTokenId;
  }

  // Legacy format: array - use first element
  if (
    Array.isArray(config.supportedTokenIds) &&
    config.supportedTokenIds.length > 0
  ) {
    const firstId = config.supportedTokenIds[0];
    return typeof firstId === "string" ? firstId : undefined;
  }

  return;
}

/**
 * Extract custom token from parsed config
 * Handles both new (single) and legacy (array/string) formats
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple legacy formats for backwards compatibility
function extractCustomToken(parsed: unknown): CustomToken | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }

  const config = parsed as Record<string, unknown>;

  // New format: single custom token object
  if (
    config.customToken &&
    typeof config.customToken === "object" &&
    config.customToken !== null
  ) {
    const token = config.customToken as Record<string, unknown>;
    if (typeof token.address === "string" && typeof token.symbol === "string") {
      return { address: token.address, symbol: token.symbol };
    }
  }

  // Legacy format: array of custom tokens - use first element
  if (Array.isArray(config.customTokens) && config.customTokens.length > 0) {
    const firstToken = config.customTokens[0];
    if (
      firstToken &&
      typeof firstToken === "object" &&
      typeof firstToken.address === "string" &&
      typeof firstToken.symbol === "string"
    ) {
      return {
        address: firstToken.address,
        symbol: firstToken.symbol,
      };
    }
  }

  // Legacy format: array of addresses - convert first address to token
  if (
    Array.isArray(config.customTokenAddresses) &&
    config.customTokenAddresses.length > 0
  ) {
    const address = config.customTokenAddresses.find(
      (a): a is string => typeof a === "string" && a.trim() !== ""
    );
    if (address) {
      return { address, symbol: "???" };
    }
  }

  // Legacy format: single address string
  if (typeof config.customTokenAddress === "string") {
    return { address: config.customTokenAddress, symbol: "???" };
  }

  return;
}

/**
 * Parse token config from input
 * Supports both new (single token) and legacy (array) formats
 */
function parseTokenConfig(input: CheckTokenBalanceInput): TokenFieldValue {
  // Legacy support: if tokenAddress is provided directly, use custom mode
  if (input.tokenAddress && !input.tokenConfig) {
    return {
      mode: "custom",
      customToken: { address: input.tokenAddress, symbol: "???" },
    };
  }

  if (!input.tokenConfig) {
    return {
      mode: "supported",
    };
  }

  // Object values from API/MCP-created workflows
  if (typeof input.tokenConfig === "object") {
    return {
      mode: extractMode(input.tokenConfig),
      supportedTokenId: extractSupportedTokenId(input.tokenConfig),
      customToken: extractCustomToken(input.tokenConfig),
    };
  }

  try {
    const parsed = JSON.parse(input.tokenConfig);

    return {
      mode: extractMode(parsed),
      supportedTokenId: extractSupportedTokenId(parsed),
      customToken: extractCustomToken(parsed),
    };
  } catch {
    // If parsing fails and it looks like an address, treat as custom
    if (input.tokenConfig.startsWith("0x")) {
      return {
        mode: "custom",
        customToken: { address: input.tokenConfig, symbol: "???" },
      };
    }
    return {
      mode: "supported",
    };
  }
}

/**
 * Get token address to check based on config
 * Returns a single token address (either supported or custom)
 */
async function getTokenAddress(
  config: TokenFieldValue,
  chainId: number
): Promise<string | null> {
  // Get supported token address from database
  if (config.supportedTokenId) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          eq(supportedTokens.id, config.supportedTokenId)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // Get custom token address
  if (config.customToken?.address) {
    return config.customToken.address;
  }

  return null;
}

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
  tokenAddress: string
): Promise<TokenBalance> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [balanceRaw, decimals, symbol, name] = await Promise.all([
    contract.balanceOf(walletAddress) as Promise<bigint>,
    contract.decimals() as Promise<bigint>,
    fetchStringOrBytes32(provider, tokenAddress, "symbol"),
    fetchStringOrBytes32(provider, tokenAddress, "name"),
  ]);

  const decimalsNum = Number(decimals);
  const balance = ethers.formatUnits(balanceRaw, decimalsNum);

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
  const userId = await getUserIdFromExecution(_context?.executionId);
  if (userId) {
    console.log(
      "[Check Token Balance] Using user RPC preferences for userId:",
      userId
    );
  }

  // Validate wallet address
  if (!ethers.isAddress(address)) {
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

  // Get chain ID from network name
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
  if (!ethers.isAddress(tokenAddress)) {
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

  // Resolve RPC provider with failover support
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
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

  // Check balance for the token
  try {
    const balance = await adapter.executeWithFailover(
      rpcManager,
      async (provider) => fetchTokenBalance(provider, address, tokenAddress)
    );

    const addressLink = await adapter.getAddressUrl(address);

    return {
      success: true,
      balance,
      address,
      addressLink,
    };
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
 * Check Token Balance Step
 * Checks the ERC20 token balance of an address for a single token
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function checkTokenBalanceStep(
  input: CheckTokenBalanceInput
): Promise<CheckTokenBalanceResult> {
  "use step";

  return withStepLogging(input, () => stepHandler(input));
}

checkTokenBalanceStep.maxRetries = 0;

export const _integrationType = "web3";
