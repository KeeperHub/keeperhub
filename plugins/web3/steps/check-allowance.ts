import "server-only";

import { ethers } from "ethers";
import ERC20_ABI from "@/lib/contracts/abis/erc20.json";
import { rawToUi, resolveForDisplay } from "@/lib/web3/ui-multiplier";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";
import { parseTokenAddress } from "./transfer-token-core";

export type CheckAllowanceCoreInput = ReadFailOnErrorInput & {
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
      // Null when failOnError=false softened a failed read into a success
      // value so the workflow continues; `error` carries the reason.
      allowance: string | null;
      allowanceRaw: string | null;
      symbol: string | null;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

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
    return { success: false,
      destinationError: true, error: getErrorMessage(error) };
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
  const userId = await getRpcPreferenceUserId(_context?.executionId);

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
    return { success: false,
      destinationError: true, error: getErrorMessage(error) };
  }

  const adapter = getChainAdapter(chainId);

  try {
    const uiMultiplier = await resolveForDisplay(
      (op) => adapter.executeWithFailover(rpcManager, op),
      chainId,
      tokenAddress
    );

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
    // Reported in the same units the approve step accepts, so a user can
    // compare what they granted against what is left without converting.
    // `allowanceRaw` keeps the on-chain value, which is what transferFrom
    // actually spends.
    //
    // MaxUint256 is left alone. Approve treats "max" as a sentinel rather than
    // a quantity, so scaling it here would report a number that is not an
    // allowance and that no longer equals the value a workflow compares
    // against when deciding whether to re-approve.
    const allowance = ethers.formatUnits(
      allowanceRaw === ethers.MaxUint256
        ? allowanceRaw
        : rawToUi(allowanceRaw, uiMultiplier),
      decimalsNum
    );

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
    const message = `Failed to check allowance: ${getErrorMessage(error)}`;
    return { success: false, error: message };
  }
}

/**
 * Check Allowance Step
 * Reads ERC20 allowance(owner, spender) to check the current spending approval
 */
export async function checkAllowanceStep(
  input: CheckAllowanceInput
): Promise<CheckAllowanceResult> {
  "use step";

  return withStepLogging(input, async () =>
    applyReadFailOnError(await stepHandler(input), input.failOnError, {
      allowance: null,
      allowanceRaw: null,
      symbol: null,
    })
  );
}

checkAllowanceStep.maxRetries = 0;

export const _integrationType = "web3";
