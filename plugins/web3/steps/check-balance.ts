import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

type CheckBalanceResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed read into a success
      // value so the workflow continues; `error` carries the reason.
      balance: string | null;
      balanceWei: string | null;
      address: string;
      addressLink: string;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

export type CheckBalanceCoreInput = ReadFailOnErrorInput & {
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
  const userId = await getRpcPreferenceUserId(_context?.executionId);
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
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  const isSolana = isSolanaChain(chainId);

  // Validate the address for the chain family.
  if (!validateChainAddress(address, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      isSolana
        ? "[Check Balance] Invalid Solana address:"
        : "[Check Balance] Invalid address:",
      address,
      { plugin_name: "web3", action_name: "check-balance" }
    );
    return {
      success: false,
      destinationError: true,
      error: isSolana
        ? `Invalid Solana address: ${address}`
        : `Invalid Ethereum address: ${address}`,
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
      destinationError: true,
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
    const message = `Failed to check balance: ${getErrorMessage(error)}`;
    return { success: false, error: message };
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
  const addressLink = await resolveExplorerLink(input.network, input.address);
  const enrichedInput: CheckBalanceInput & { addressLink?: string } =
    addressLink ? { ...input, addressLink } : input;

  return runPluginStep(
    { pluginName: "web3", actionName: "check-balance" },
    enrichedInput,
    async () =>
      applyReadFailOnError(await stepHandler(input), input.failOnError, {
        balance: null,
        balanceWei: null,
        address: input.address,
        addressLink: "",
      })
  );
}

checkBalanceStep.maxRetries = 0;

export const _integrationType = "web3";
