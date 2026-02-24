/**
 * Core write-contract logic shared between web3 write-contract and protocol-write steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse write logic without
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

export type WriteContractCoreInput = {
  contractAddress: string;
  network: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  gasLimitMultiplier?: string;
  _context?: {
    executionId?: string;
    triggerType?: string;
    organizationId?: string;
  };
};

export type WriteContractResult =
  | {
      success: true;
      transactionHash: string;
      transactionLink: string;
      gasUsed: string;
      result?: unknown;
    }
  | { success: false; error: string };

/**
 * Core write contract logic
 *
 * Shared between the web3 write-contract step and the future protocol-write step.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Contract interaction requires extensive validation
export async function writeContractCore(
  input: WriteContractCoreInput
): Promise<WriteContractResult> {
  const {
    contractAddress,
    network,
    abi,
    abiFunction,
    functionArgs,
    gasLimitMultiplier,
    _context,
  } = input;

  const { multiplierOverride, gasLimitOverride } =
    resolveGasLimitOverrides(gasLimitMultiplier);

  // Validate contract address
  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  // Parse ABI
  let parsedAbi: unknown;
  try {
    parsedAbi = JSON.parse(abi);
  } catch (error) {
    return {
      success: false,
      error: `Invalid ABI JSON: ${getErrorMessage(error)}`,
    };
  }

  // Validate ABI is an array
  if (!Array.isArray(parsedAbi)) {
    return {
      success: false,
      error: "ABI must be a JSON array",
    };
  }

  // Find the selected function in the ABI
  const functionAbi = parsedAbi.find(
    (item: { type: string; name: string }) =>
      item.type === "function" && item.name === abiFunction
  );

  if (!functionAbi) {
    return {
      success: false,
      error: `Function '${abiFunction}' not found in ABI`,
    };
  }

  // Parse function arguments
  let args: unknown[] = [];
  if (functionArgs && functionArgs.trim() !== "") {
    try {
      const parsedArgs = JSON.parse(functionArgs);
      if (!Array.isArray(parsedArgs)) {
        return {
          success: false,
          error: "Function arguments must be a JSON array",
        };
      }
      // Filter out empty strings at the end of the array (from UI padding)
      args = parsedArgs.filter((arg, index) => {
        // Keep all non-empty values
        if (arg !== "") {
          return true;
        }
        // Keep empty strings if they're not at the end
        return parsedArgs.slice(index + 1).some((a) => a !== "");
      });
    } catch (error) {
      return {
        success: false,
        error: `Invalid function arguments JSON: ${getErrorMessage(error)}`,
      };
    }
  }

  // Get organizationId from _context (direct execution provides it, workflow execution derives it)
  const orgCtx = await resolveOrganizationContext(
    _context ?? {},
    "[Write Contract]",
    "write-contract"
  );
  if (!orgCtx.success) {
    return { success: false, error: orgCtx.error };
  }
  const { organizationId, userId } = orgCtx;

  // Get chain ID and resolve RPC config (with user preferences)
  let chainId: number;
  let rpcUrl: string;
  try {
    chainId = getChainIdFromNetwork(network);
    console.log("[Write Contract] Resolved chain ID:", chainId);

    const rpcConfig = await resolveRpcConfig(chainId, userId);
    if (!rpcConfig) {
      throw new Error(`Chain ${chainId} not found or not enabled`);
    }

    rpcUrl = rpcConfig.primaryRpcUrl;
    console.log(
      "[Write Contract] Using RPC URL:",
      rpcUrl,
      "source:",
      rpcConfig.source
    );
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Write Contract] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "write-contract",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  // Get wallet address for nonce management
  let walletAddress: string;
  try {
    walletAddress = await getOrganizationWalletAddress(organizationId);
  } catch (error) {
    console.error("[Write Contract] Failed to get wallet address:", error);
    return {
      success: false,
      error: `Failed to get wallet address: ${getErrorMessage(error)}`,
    };
  }

  // Get workflow ID for transaction tracking (only for workflow executions)
  let workflowId: string | undefined;
  if (_context?.executionId && !_context?.organizationId) {
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
    executionId: _context?.executionId ?? "direct-execution",
    workflowId,
    chainId,
    rpcUrl,
    triggerType: _context?.triggerType as TransactionContext["triggerType"],
  };

  // Execute transaction with nonce management and gas strategy
  return withNonceSession(txContext, walletAddress, async (session) => {
    const nonceManager = getNonceManager();
    const gasStrategy = getGasStrategy();

    // Initialize Para signer
    let signer: Awaited<ReturnType<typeof initializeParaSigner>>;
    try {
      signer = await initializeParaSigner(organizationId, rpcUrl);
    } catch (error) {
      console.error(
        "[Write Contract] Failed to initialize organization wallet:",
        error
      );
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create contract instance with signer
    let contract: ethers.Contract;
    try {
      contract = new ethers.Contract(contractAddress, parsedAbi, signer);
    } catch (error) {
      console.error(
        "[Write Contract] Failed to create contract instance:",
        error
      );
      return {
        success: false,
        error: `Failed to create contract instance: ${getErrorMessage(error)}`,
      };
    }

    // Call the contract function
    try {
      // Check if function exists
      if (typeof contract[abiFunction] !== "function") {
        return {
          success: false,
          error: `Function '${abiFunction}' not found in contract ABI`,
        };
      }

      // Get nonce from session
      const nonce = nonceManager.getNextNonce(session);

      // Estimate gas for the contract call
      const estimatedGas = await contract[abiFunction].estimateGas(...args);

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

      console.log("[Write Contract] Gas config:", {
        function: abiFunction,
        estimatedGas: estimatedGas.toString(),
        gasLimit: txGasConfig.gasLimit.toString(),
        maxFeePerGas: `${ethers.formatUnits(txGasConfig.maxFeePerGas, "gwei")} gwei`,
        maxPriorityFeePerGas: `${ethers.formatUnits(txGasConfig.maxPriorityFeePerGas, "gwei")} gwei`,
      });

      // Execute contract call with managed nonce and gas config
      const tx = await contract[abiFunction](...args, {
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

      // Mark transaction as confirmed
      await nonceManager.confirmTransaction(tx.hash);

      console.log("[Write Contract] Transaction confirmed:", {
        hash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: `${ethers.formatUnits(receipt.gasPrice, "gwei")} gwei`,
      });

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
        result: undefined,
      };
    } catch (error) {
      logUserError(
        ErrorCategory.NETWORK_RPC,
        "[Write Contract] Function call failed",
        error,
        {
          plugin_name: "web3",
          action_name: "write-contract",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: `Contract call failed: ${getErrorMessage(error)}`,
      };
    }
  });
}
