import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getAddressUrl, getTransactionUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

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

type GetTransactionResult =
  | {
      success: true;
      hash: string;
      from: string;
      to: string | null;
      value: string;
      input: string;
      nonce: number;
      gasLimit: string;
      blockNumber: number | null;
      transactionLink: string;
      fromLink: string;
      toLink: string;
    }
  | { success: false; error: string };

export type GetTransactionCoreInput = {
  network: string;
  transactionHash: string;
};

export type GetTransactionInput = StepInput & GetTransactionCoreInput;

async function stepHandler(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  const { network, transactionHash, _context } = input;

  if (!transactionHash?.trim()) {
    return {
      success: false,
      error: "Transaction hash is required",
    };
  }

  const hash = transactionHash.trim();
  if (!TX_HASH_PATTERN.test(hash)) {
    return {
      success: false,
      error: `Invalid transaction hash format: ${hash}`,
    };
  }

  const userId = await getUserIdFromExecution(_context?.executionId);

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  try {
    const tx = await rpcManager.executeWithFailover(async (provider) =>
      provider.getTransaction(hash)
    );

    if (!tx) {
      return {
        success: false,
        error: `Transaction not found: ${hash}`,
      };
    }

    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });

    const transactionLink = explorerConfig
      ? getTransactionUrl(explorerConfig, hash)
      : "";
    const fromLink = explorerConfig
      ? getAddressUrl(explorerConfig, tx.from)
      : "";
    const toLink =
      explorerConfig && tx.to ? getAddressUrl(explorerConfig, tx.to) : "";

    return {
      success: true,
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: ethers.formatEther(tx.value),
      input: tx.data,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit.toString(),
      blockNumber: tx.blockNumber,
      transactionLink,
      fromLink,
      toLink,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch transaction: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Get Transaction Step
 * Fetches full transaction details by hash via eth_getTransactionByHash.
 * Returns from, to, value, input (calldata), nonce, gas, and explorer links.
 */
export async function getTransactionStep(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  "use step";

  let enrichedInput: GetTransactionInput & { transactionLink?: string } = input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const transactionLink = getTransactionUrl(
        explorerConfig,
        input.transactionHash
      );
      if (transactionLink) {
        enrichedInput = { ...input, transactionLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return await withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "get-transaction",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => stepHandler(input))
  );
}

getTransactionStep.maxRetries = 0;

export const _integrationType = "web3";
