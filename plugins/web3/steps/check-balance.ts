import "server-only";

import { PublicKey } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getAddressUrl } from "@/lib/explorer";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
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

type CheckBalanceResult =
  | {
      success: true;
      balance: string;
      balanceWei: string;
      address: string;
      addressLink: string;
    }
  | { success: false; error: string };

export type CheckBalanceCoreInput = {
  network: string;
  address: string;
};

export type CheckBalanceInput = StepInput & CheckBalanceCoreInput;

/**
 * Core check balance logic
 */
async function stepHandler(
  input: CheckBalanceInput
): Promise<CheckBalanceResult> {
  console.log("[Check Balance] Starting step with input:", {
    network: input.network,
    address: input.address,
    executionId: input._context?.executionId,
  });

  const { network, address, _context } = input;

  // Get userId from execution context (for user RPC preferences)
  const userId = await getUserIdFromExecution(_context?.executionId);
  if (userId) {
    console.log(
      "[Check Balance] Using user RPC preferences for userId:",
      userId
    );
  }

  // Resolve the chain first so address validation, RPC handling, and balance
  // formatting can branch on the chain family (EVM vs Solana).
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
    console.log("[Check Balance] Resolved chain ID:", chainId);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Balance] Failed to resolve network:",
      error,
      {
        plugin_name: "web3",
        action_name: "check-balance",
      }
    );
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  const isSolana = isSolanaChain(chainId);

  // Validate the address for the chain family.
  if (isSolana) {
    try {
      // Throws on non-base58 / wrong-length input.
      new PublicKey(address);
    } catch {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Check Balance] Invalid Solana address:",
        address,
        { plugin_name: "web3", action_name: "check-balance" }
      );
      return {
        success: false,
        error: `Invalid Solana address: ${address}`,
      };
    }
  } else if (!ethers.isAddress(address)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Balance] Invalid address:",
      address,
      {
        plugin_name: "web3",
        action_name: "check-balance",
      }
    );
    return {
      success: false,
      error: `Invalid Ethereum address: ${address}`,
    };
  }

  // Resolve RPC provider (EVM only). SolanaChainAdapter owns its own provider
  // manager and ignores the rpcManager argument, so we skip EVM RPC resolution.
  let rpcManager: RpcProviderManager | undefined;
  if (!isSolana) {
    try {
      rpcManager = await getRpcProvider({ chainId, userId });
    } catch (error) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Check Balance] Failed to resolve RPC config:",
        error,
        {
          plugin_name: "web3",
          action_name: "check-balance",
          chain_id: String(chainId),
        }
      );
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  const adapter = getChainAdapter(chainId);

  // Check balance. Native decimals differ by family: 18 for EVM, 9 for Solana.
  try {
    const balance = await adapter.getBalance(rpcManager, address);
    const balanceFormatted = ethers.formatUnits(balance, isSolana ? 9 : 18);

    const addressLink = await adapter.getAddressUrl(address);

    return {
      success: true,
      balance: balanceFormatted,
      balanceWei: balance.toString(),
      address,
      addressLink,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Check Balance] Failed to check balance:",
      error,
      {
        plugin_name: "web3",
        action_name: "check-balance",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: `Failed to check balance: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Check Balance Step
 * Checks the ETH balance of an address (contract or wallet)
 */
export async function checkBalanceStep(
  input: CheckBalanceInput
): Promise<CheckBalanceResult> {
  "use step";

  // Enrich input with address explorer link for the execution log
  let enrichedInput: CheckBalanceInput & { addressLink?: string } = input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const addressLink = getAddressUrl(explorerConfig, input.address);
      if (addressLink) {
        enrichedInput = { ...input, addressLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "check-balance",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => stepHandler(input))
  );
}

checkBalanceStep.maxRetries = 0;

export const _integrationType = "web3";
