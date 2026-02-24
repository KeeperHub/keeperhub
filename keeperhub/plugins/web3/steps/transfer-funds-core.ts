/**
 * Core transfer-funds logic shared between web3 transfer-funds step and direct execution API.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple callers can reuse transfer logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
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
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { getChainIdFromNetwork, resolveRpcConfig } from "@/lib/rpc";
import { getErrorMessage } from "@/lib/utils";

export type TransferFundsCoreInput = {
  network: string;
  amount: string;
  recipientAddress: string;
  gasLimitMultiplier?: string;
  _context?: {
    executionId?: string;
    triggerType?: string;
    organizationId?: string;
  };
};

export type TransferFundsResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
    }
  | { success: false; error: string };

/**
 * Core transfer funds logic
 *
 * Shared between the web3 transfer-funds step and the direct execution API.
 * When _context.organizationId is provided, skips workflowExecutions lookup.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Transfer handler with comprehensive validation and error handling
export async function transferFundsCore(
  input: TransferFundsCoreInput
): Promise<TransferFundsResult> {
  const { network, amount, recipientAddress, gasLimitMultiplier, _context } =
    input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

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

  let amountInWei: bigint;
  try {
    amountInWei = ethers.parseEther(amount);
  } catch (error) {
    return {
      success: false,
      error: `Invalid amount format: ${getErrorMessage(error)}`,
    };
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
    "[Transfer Funds]",
    "transfer-funds"
  );
  if (!orgCtx.success) {
    return orgCtx;
  }

  const { organizationId, userId } = orgCtx;

  // Get chain ID and resolve RPC config
  let chainId: number;
  let rpcUrl: string;
  try {
    chainId = getChainIdFromNetwork(network);

    const rpcConfig = await resolveRpcConfig(chainId, userId);
    if (!rpcConfig) {
      throw new Error(`Chain ${chainId} not found or not enabled`);
    }
    rpcUrl = rpcConfig.primaryRpcUrl;
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Transfer Funds] Failed to resolve RPC config",
      error,
      { plugin_name: "web3", action_name: "transfer-funds" }
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

    let signer: Awaited<ReturnType<typeof initializeParaSigner>>;
    try {
      signer = await initializeParaSigner(organizationId, rpcUrl);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Get nonce from session
    const nonce = nonceManager.getNextNonce(session);

    // Send transaction with managed nonce and gas strategy
    try {
      const provider = signer.provider;
      if (!provider) {
        throw new Error("Signer has no provider");
      }

      const baseTx = { to: recipientAddress, value: amountInWei };

      // Estimate gas
      const estimatedGas = await provider.estimateGas({
        ...baseTx,
        from: walletAddress,
      });

      // Get gas configuration from strategy
      const txGasConfig = await gasStrategy.getGasConfig(
        provider,
        txContext.triggerType ?? "manual",
        estimatedGas,
        chainId,
        multiplierOverride,
        gasLimitOverride
      );

      // Send transaction with nonce and gas config
      const tx = await signer.sendTransaction({
        ...baseTx,
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
      };
    } catch (error) {
      logUserError(
        ErrorCategory.TRANSACTION,
        "[Transfer Funds] Transaction failed",
        error,
        {
          plugin_name: "web3",
          action_name: "transfer-funds",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: `Transaction failed: ${getErrorMessage(error)}`,
      };
    }
  });
}
