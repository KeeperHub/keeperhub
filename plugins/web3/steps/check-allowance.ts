import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { parseTokenAddress } from "./transfer-token-core";

export type CheckAllowanceCoreInput = {
  network: string;
  tokenConfig: string | Record<string, unknown>;
  ownerAddress: string;
  spenderAddress: string;
  tokenAddress?: string;
};

export type CheckAllowanceInput = StepInput & CheckAllowanceCoreInput;

type CheckAllowanceResult =
  | {
      success: true;
      allowance: string;
      allowanceRaw: string;
      symbol: string;
    }
  | { success: false; error: string };

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

async function stepHandler(
  input: CheckAllowanceInput
): Promise<CheckAllowanceResult> {
  const { network, ownerAddress, spenderAddress, _context } = input;

  // Get chain ID
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Allowance] Failed to resolve network",
      error,
      { plugin_name: "web3", action_name: "check-allowance" }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  // Parse token address from config
  const tokenAddress = await parseTokenAddress(input, chainId);

  if (!(tokenAddress && ethers.isAddress(tokenAddress))) {
    return {
      success: false,
      error: tokenAddress
        ? `Invalid token address: ${tokenAddress}`
        : "No token selected",
    };
  }

  // Validate owner address
  if (!ethers.isAddress(ownerAddress)) {
    return {
      success: false,
      error: `Invalid owner address: ${ownerAddress}`,
    };
  }

  // Validate spender address
  if (!ethers.isAddress(spenderAddress)) {
    return {
      success: false,
      error: `Invalid spender address: ${spenderAddress}`,
    };
  }

  // Get userId from execution context (for user RPC preferences)
  const userId = await getUserIdFromExecution(_context?.executionId);

  // Resolve RPC provider with failover support
  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Check Allowance] Failed to resolve RPC config",
      error,
      {
        plugin_name: "web3",
        action_name: "check-allowance",
        chain_id: String(chainId),
      }
    );
    return { success: false, error: getErrorMessage(error) };
  }

  const adapter = getChainAdapter(chainId);

  try {
    const [allowanceRaw, decimals, symbol] = await adapter.executeWithFailover(
      rpcManager,
      (provider) => {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        return Promise.all([
          contract.allowance(ownerAddress, spenderAddress) as Promise<bigint>,
          contract.decimals() as Promise<bigint>,
          contract.symbol() as Promise<string>,
        ]);
      }
    );

    const decimalsNum = Number(decimals);
    const allowance = ethers.formatUnits(allowanceRaw, decimalsNum);

    return {
      success: true,
      allowance,
      allowanceRaw: allowanceRaw.toString(),
      symbol,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Check Allowance] Failed to check allowance",
      error,
      {
        plugin_name: "web3",
        action_name: "check-allowance",
        chain_id: String(chainId),
      }
    );
    return {
      success: false,
      error: `Failed to check allowance: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Check Allowance Step
 * Reads ERC20 allowance(owner, spender) to check the current spending approval
 */
// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function checkAllowanceStep(
  input: CheckAllowanceInput
): Promise<CheckAllowanceResult> {
  "use step";

  return withStepLogging(input, () => stepHandler(input));
}

checkAllowanceStep.maxRetries = 0;

export const _integrationType = "web3";
