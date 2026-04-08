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
import { reshapeArgsForAbi } from "@/lib/abi-struct-args";
import { validateArgsForAbi } from "@/lib/abi-validate-args";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getTransactionUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getOrganizationWalletAddress,
  initializeWalletSigner,
} from "@/lib/para/wallet-helpers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getAbiFunctionKey } from "@/lib/web3/abi-function-key";
import { generateId } from "@/lib/utils/id";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { formatContractError } from "@/lib/web3/decode-revert-error";
import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { executeSponsoredContractTransaction } from "@/lib/web3/sponsored-transaction-manager";
import {
  type TransactionContext,
  withNonceSession,
} from "@/lib/web3/transaction-manager";

export type WriteContractCoreInput = {
  contractAddress: string;
  network: string;
  abi: string;
  abiFunction: string;
  functionArgs?: string;
  ethValue?: string;
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
      gasUsedUnits: string;
      effectiveGasPrice: string;
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
    ethValue,
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

  const abiFunctionKey = getAbiFunctionKey(parsedAbi, abiFunction, functionAbi);

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
      args = reshapeArgsForAbi(args, functionAbi);
      const validation = validateArgsForAbi(args, functionAbi);
      if (!validation.ok) {
        return {
          success: false,
          error: `Invalid function arguments: ${validation.error}`,
        };
      }
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

  // Get chain ID and resolve RPC config (with user preferences + failover)
  let chainId: number;
  let rpcUrl: string;
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    chainId = getChainIdFromNetwork(network);

    rpcManager = await getRpcProvider({ chainId, userId });
    rpcUrl = await rpcManager.resolveActiveRpcUrl();
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

  // Parse ethValue early so we fail fast with a friendly message.
  // Reject any non-zero value sent to a non-payable function: the UI hides
  // the field for non-payable functions, but the API and workflow layers
  // accept ethValue as an arbitrary string, so this is the authoritative
  // server-side guard against accidentally sending native tokens to a
  // function that cannot accept them (the tx would revert on-chain anyway,
  // but failing here is faster, cheaper, and produces a clearer error).
  let parsedEthValue: bigint | undefined;
  if (ethValue && ethValue.trim() !== "") {
    try {
      parsedEthValue = ethers.parseEther(ethValue);
    } catch {
      return {
        success: false,
        error: `Invalid payable value "${ethValue}" -- expected a decimal string like "0.1" or "1.5"`,
      };
    }

    if (
      parsedEthValue > BigInt(0) &&
      (functionAbi as { stateMutability?: string }).stateMutability !==
        "payable"
    ) {
      return {
        success: false,
        error: `Function '${abiFunction}' is not payable -- cannot send a non-zero value with this call`,
      };
    }
  }

  // Build transaction context
  const txContext: TransactionContext = {
    organizationId,
    executionId: _context?.executionId ?? `direct-${generateId()}`,
    workflowId,
    chainId,
    rpcUrl,
    triggerType: _context?.triggerType as TransactionContext["triggerType"],
    rpcManager,
  };

  // Try gas-sponsored execution first (ERC-4337 via Pimlico)
  try {
    const sponsoredResult = await executeSponsoredContractTransaction({
      organizationId,
      executionId: _context?.executionId ?? "direct-execution",
      chainId,
      rpcUrl,
      walletAddress,
      to: contractAddress,
      // biome-ignore lint/suspicious/noExplicitAny: ABI parsed from user-provided JSON string, type is unknown[]
      abi: parsedAbi as any,
      functionName: abiFunction,
      args,
      value: parsedEthValue,
    });

    if (sponsoredResult !== null) {
      const explorerConfig = await db.query.explorerConfigs.findFirst({
        where: eq(explorerConfigs.chainId, chainId),
      });
      const transactionLink = explorerConfig
        ? getTransactionUrl(explorerConfig, sponsoredResult.transactionHash)
        : "";

      return {
        success: true,
        transactionHash: sponsoredResult.transactionHash,
        transactionLink,
        gasUsed: sponsoredResult.gasUsed,
        gasUsedUnits: sponsoredResult.gasUsedUnits,
        effectiveGasPrice: sponsoredResult.effectiveGasPrice,
      };
    }

    logUserError(
      ErrorCategory.TRANSACTION,
      "[Write Contract] Sponsorship skipped (credits exhausted, chain unsupported, or client creation failed), falling back to direct signing",
      undefined,
      {
        plugin_name: "web3",
        action_name: "write-contract",
        chain_id: String(chainId),
      }
    );
  } catch (error) {
    logUserError(
      ErrorCategory.TRANSACTION,
      "[Write Contract] Sponsorship attempted but failed, falling back to direct signing",
      error,
      {
        plugin_name: "web3",
        action_name: "write-contract",
        chain_id: String(chainId),
      }
    );
  }

  // Fall back to direct signing with nonce management and RPC failover
  const adapter = getChainAdapter(chainId);

  return withNonceSession(txContext, walletAddress, async (session) => {
    // Initialize Para signer
    let signer: Awaited<ReturnType<typeof initializeWalletSigner>>;
    try {
      signer = await initializeWalletSigner(organizationId, rpcUrl);
    } catch (error) {
      return {
        success: false,
        error: `Failed to initialize organization wallet: ${getErrorMessage(error)}`,
      };
    }

    // Create a contract interface for error formatting on failure
    let contractInterface: ethers.Interface | undefined;
    try {
      contractInterface = new ethers.Interface(parsedAbi as ethers.InterfaceAbi);
    } catch {
      // Non-critical -- error formatting will fall back to generic messages
    }

    try {
      const receipt = await adapter.executeContractCall(signer, {
        contractAddress,
        abi: parsedAbi as ethers.InterfaceAbi,
        functionKey: abiFunctionKey,
        args,
        value: parsedEthValue,
      }, session, {
        triggerType: txContext.triggerType ?? "manual",
        gasOverrides: { multiplierOverride, gasLimitOverride },
        workflowId,
      });

      const gasUsedUnits = receipt.gasUsed.toString();
      const effectiveGasPrice = receipt.effectiveGasPrice.toString();
      const gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      const transactionLink = await adapter.getTransactionUrl(receipt.hash);

      return {
        success: true,
        transactionHash: receipt.hash,
        transactionLink,
        gasUsed: gasCostWei,
        gasUsedUnits,
        effectiveGasPrice,
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
        error: formatContractError(error, contractInterface),
      };
    }
  });
}
