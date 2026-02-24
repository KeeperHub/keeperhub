/**
 * Core transfer-token logic shared between web3 transfer-token step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse transfer logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { ethers } from "ethers";
import { ErrorCategory, logUserError } from "@/keeperhub/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeParaSigner,
} from "@/keeperhub/lib/para/wallet-helpers";
import { resolveGasLimitOverrides } from "@/keeperhub/lib/web3/gas-defaults";
import { getGasStrategy } from "@/keeperhub/lib/web3/gas-strategy";
import { getNonceManager } from "@/keeperhub/lib/web3/nonce-manager";
import { resolveOrganizationContext } from "@/keeperhub/lib/web3/resolve-org-context";
import {
  type TransactionContext,
  withNonceSession,
} from "@/keeperhub/lib/web3/transaction-manager";
import { ERC20_ABI } from "@/lib/contracts";
import { db } from "@/lib/db";
import {
  explorerConfigs,
  supportedTokens,
  workflowExecutions,
} from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { getChainIdFromNetwork, resolveRpcConfig } from "@/lib/rpc";
import { getErrorMessage } from "@/lib/utils";

export type TransferTokenCoreInput = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  recipientAddress: string;
  amount: string;
  gasLimitMultiplier?: string;
  tokenAddress?: string;
  _context?: {
    executionId?: string;
    triggerType?: string;
    organizationId?: string;
  };
};

export type TransferTokenResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      amount: string;
      symbol: string;
      recipient: string;
    }
  | { success: false; error: string };

/**
 * Parse token config from input and return a single token address.
 * Supports both new (single token) and legacy (array) formats.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Handles multiple token config formats for backwards compatibility
export async function parseTokenAddress(
  input: Pick<TransferTokenCoreInput, "tokenConfig" | "tokenAddress">,
  chainId: number
): Promise<string | null> {
  // Legacy support: if tokenAddress is provided directly, use it
  if (input.tokenAddress && !input.tokenConfig) {
    return input.tokenAddress;
  }

  if (!input.tokenConfig) {
    return null;
  }

  // Object values from API/MCP-created workflows -- normalize to parsed form
  const parsed =
    typeof input.tokenConfig === "object"
      ? input.tokenConfig
      : (() => {
          try {
            return JSON.parse(input.tokenConfig as string);
          } catch {
            return null;
          }
        })();

  if (!parsed) {
    // JSON parse failed -- check if it's a bare address string
    if (
      typeof input.tokenConfig === "string" &&
      input.tokenConfig.startsWith("0x")
    ) {
      return input.tokenConfig;
    }
    return null;
  }

  // New format: single supported token ID
  if (parsed.supportedTokenId) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          eq(supportedTokens.id, parsed.supportedTokenId)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // Legacy format: array of supported token IDs - use first
  if (
    Array.isArray(parsed.supportedTokenIds) &&
    parsed.supportedTokenIds.length > 0
  ) {
    const tokens = await db
      .select({ tokenAddress: supportedTokens.tokenAddress })
      .from(supportedTokens)
      .where(
        and(
          eq(supportedTokens.chainId, chainId),
          inArray(supportedTokens.id, parsed.supportedTokenIds)
        )
      )
      .limit(1);
    if (tokens[0]?.tokenAddress) {
      return tokens[0].tokenAddress;
    }
  }

  // New format: single custom token
  if (parsed.customToken?.address) {
    return parsed.customToken.address;
  }

  // Legacy format: array of custom tokens - use first
  if (Array.isArray(parsed.customTokens) && parsed.customTokens.length > 0) {
    return parsed.customTokens[0].address;
  }

  // Legacy: check old formats
  if (
    Array.isArray(parsed.customTokenAddresses) &&
    parsed.customTokenAddresses.length > 0
  ) {
    const addr = parsed.customTokenAddresses.find(
      (a: string) => a && a.trim() !== ""
    );
    if (addr) {
      return addr;
    }
  } else if (parsed.customTokenAddress) {
    return parsed.customTokenAddress;
  }

  return null;
}

/**
 * Core transfer token logic
 *
 * Shared between the web3 transfer-token step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Token transfer handler with comprehensive validation and error handling
export async function transferTokenCore(
  input: TransferTokenCoreInput
): Promise<TransferTokenResult> {
  const { network, recipientAddress, amount, gasLimitMultiplier, _context } =
    input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Get chain ID first (needed for token config parsing)
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Transfer Token] Failed to resolve network",
      error,
      { plugin_name: "web3", action_name: "transfer-token" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Parse token address from config
  const tokenAddress = await parseTokenAddress(input, chainId);

  // Validate token address
  if (!(tokenAddress && ethers.isAddress(tokenAddress))) {
    return {
      success: false,
      error: tokenAddress
        ? `Invalid token address: ${tokenAddress}`
        : "No token selected",
    };
  }

  // Validate recipient address
  if (!ethers.isAddress(recipientAddress)) {
    return {
      success: false,
      error: `Invalid recipient address: ${recipientAddress}`,
    };
  }

  // Validate amount
  if (!amount || amount.trim() === "") {
    return { success: false, error: "Amount is required" };
  }

  // Resolve organization context
  if (!(_context?.executionId || _context?.organizationId)) {
    return {
      success: false,
      error: "Execution ID or organization ID is required",
    };
  }

  const orgCtx = await resolveOrganizationContext(
    _context,
    "[Transfer Token]",
    "transfer-token"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Resolve RPC config
  let rpcUrl: string;
  try {
    const rpcConfig = await resolveRpcConfig(chainId, userId);
    if (!rpcConfig) {
      throw new Error(`Chain ${chainId} not found or not enabled`);
    }
    rpcUrl = rpcConfig.primaryRpcUrl;
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Transfer Token] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "transfer-token",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Get wallet address for nonce management
  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
    };
  }

  // Get workflow ID for transaction tracking (only for workflow executions)
  let workflowId: string | undefined;
  if (_context.executionId && !_context.organizationId) {
    try {
      const execution = await db
        .select({ workflowId: workflowExecutions.workflowId })
        .from(workflowExecutions)
        .where(eq(workflowExecutions.id, _context.executionId))
        .then((rows) => rows[0]);
      workflowId = execution?.workflowId ?? undefined;
    } catch {
      // Non-critical - workflowId is optional for tracking
    }
  }

  // Build transaction context
  const txContext: TransactionContext = {
    organizationId,
    executionId: _context.executionId ?? "direct-execution",
    workflowId,
    chainId,
    rpcUrl,
    triggerType: _context.triggerType as TransactionContext["triggerType"],
  };

  // Execute transaction with nonce management and gas strategy
  return withNonceSession(txContext, walletAddress, async (session) => {
    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    // Initialize Para signer
    let signer: Awaited<ReturnType<typeof initializeParaSigner>>;
    let signerAddress: string;
    try {
      signer = await initializeParaSigner(organizationId, rpcUrl);
      signerAddress = await signer.getAddress();
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create contract instance with signer
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

    try {
      // Get token decimals and symbol
      const [decimals, symbol] = await Promise.all([
        contract.decimals() as Promise<bigint>,
        contract.symbol() as Promise<string>,
      ]);

      const decimalsNum = Number(decimals);

      // Convert amount to raw units
      let amountRaw: bigint;
      try {
        amountRaw = ethers.parseUnits(amount, decimalsNum);
      } catch (error) {
        return {
          success: false,
          error: `Invalid amount format: ${getErrorMessage(error)}`,
        };
      }

      // Check balance before transfer
      const balance = (await contract.balanceOf(signerAddress)) as bigint;
      if (balance < amountRaw) {
        const balanceFormatted = ethers.formatUnits(balance, decimalsNum);
        return {
          success: false,
          error: `Insufficient ${symbol} balance. Have: ${balanceFormatted}, Need: ${amount}`,
        };
      }

      // Get nonce from session
      const nonce = nonceManager.getNextNonce(session);

      // Estimate gas for the transfer
      const estimatedGas = await contract.transfer.estimateGas(
        recipientAddress,
        amountRaw
      );

      // Get gas configuration from strategy
      const provider = signer.provider;
      if (!provider) {
        throw new Error("Signer has no provider");
      }

      const txGasConfig = await gasStrategy.getGasConfig(
        provider,
        txContext.triggerType ?? "manual",
        estimatedGas,
        chainId,
        multiplierOverride,
        gasLimitOverride
      );

      // Execute transfer with managed nonce and gas config
      const tx = await contract.transfer(recipientAddress, amountRaw, {
        nonce,
        gasLimit: txGasConfig.gasLimit,
        maxFeePerGas: txGasConfig.maxFeePerGas,
        maxPriorityFeePerGas: txGasConfig.maxPriorityFeePerGas,
      });

      // Record pending transaction
      await nonceManager.recordTransaction(
        session,
        nonce,
        tx.hash,
        workflowId,
        txGasConfig.maxFeePerGas.toString()
      );

      // Wait for transaction to be mined
      const receipt = await tx.wait();

      if (!receipt) {
        return {
          success: false,
          error: "Transaction sent but receipt not available",
        };
      }

      // Mark transaction as confirmed
      await nonceManager.confirmTransaction(tx.hash);

      // Fetch explorer config for transaction link
      const explorerConfig = await db.query.explorerConfigs.findFirst({
        where: eq(explorerConfigs.chainId, chainId),
      });
      const transactionLink = explorerConfig
        ? getTransactionUrl(explorerConfig, receipt.hash)
        : "";

      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
        gasUsed: receipt.gasUsed.toString(),
        amount,
        symbol,
        recipient: recipientAddress,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Token] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-token",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: `Token transfer failed: ${getErrorMessage(error)}`,
      };
    }
  });
}
