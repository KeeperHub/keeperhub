import "server-only";

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getErrorMessage } from "@/lib/utils";
import { resolveExplorerLink } from "@/lib/web3/explorer-link";
import {
  evmOnlyGuard,
  validateChainAddress,
} from "@/lib/web3/validate-chain-address";
import { getRpcPreferenceUserId } from "@/lib/workflow/executor/helpers";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  applyReadFailOnError,
  type ReadDestinationFailure,
  type ReadFailOnErrorInput,
} from "./read-fail-on-error-core";

const NONCE_BLOCK_TAGS = ["latest", "pending"] as const;
type NonceBlockTag = (typeof NONCE_BLOCK_TAGS)[number];
const DEFAULT_BLOCK_TAG: NonceBlockTag = "latest";

const LOG_LABELS = { plugin_name: "web3", action_name: "get-nonce" };

type GetNonceResult =
  | {
      success: true;
      // Null when failOnError=false softened a failed read; `error` carries the reason.
      nonce: number | null;
      latestNonce: number | null;
      pendingNonce: number | null;
      pendingCount: number | null;
      blockTag: string;
      address: string;
      error?: string;
    }
  | (ReadDestinationFailure & { success: false; error: string });

type GetNonceCoreInput = ReadFailOnErrorInput & {
  network: string;
  address: string;
  blockTag?: string;
};

export type GetNonceInput = StepInput & GetNonceCoreInput;

function requestedBlockTag(blockTag: string | undefined): string {
  return blockTag || DEFAULT_BLOCK_TAG;
}

function isNonceBlockTag(value: string): value is NonceBlockTag {
  return (NONCE_BLOCK_TAGS as readonly string[]).includes(value);
}

async function stepHandler(input: GetNonceInput): Promise<GetNonceResult> {
  const { network, address, _context } = input;

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get Nonce] Failed to resolve network:",
      error,
      LOG_LABELS
    );
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  const evmOnlyResult = evmOnlyGuard(chainId);
  if (evmOnlyResult) {
    return { ...evmOnlyResult, destinationError: true };
  }

  if (!validateChainAddress(address, chainId)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get Nonce] Invalid address:",
      address,
      LOG_LABELS
    );
    return {
      success: false,
      destinationError: true,
      error: `Invalid Ethereum address: ${address}`,
    };
  }

  const blockTag = requestedBlockTag(input.blockTag);
  if (!isNonceBlockTag(blockTag)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get Nonce] Invalid block tag:",
      blockTag,
      LOG_LABELS
    );
    return {
      success: false,
      error: `Invalid block tag: ${blockTag}. Expected one of: ${NONCE_BLOCK_TAGS.join(", ")}`,
    };
  }

  const userId = await getRpcPreferenceUserId(_context?.executionId);

  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Get Nonce] Failed to resolve RPC config:",
      error,
      { ...LOG_LABELS, chain_id: String(chainId) }
    );
    return {
      success: false,
      destinationError: true,
      error: getErrorMessage(error),
    };
  }

  try {
    // One failover call, so the two reads cannot land on different RPC providers.
    const [latestNonce, pendingNonce] = await rpcManager.executeWithFailover(
      (provider) =>
        Promise.all([
          provider.getTransactionCount(address, "latest"),
          provider.getTransactionCount(address, "pending"),
        ])
    );

    return {
      success: true,
      nonce: blockTag === "pending" ? pendingNonce : latestNonce,
      latestNonce,
      pendingNonce,
      // A load-balanced endpoint can still answer the two reads from different backends.
      pendingCount: Math.max(0, pendingNonce - latestNonce),
      blockTag,
      address,
    };
  } catch (error) {
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Get Nonce] Failed to read nonce:",
      error,
      { ...LOG_LABELS, chain_id: String(chainId) }
    );
    return {
      success: false,
      error: `Failed to read nonce: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Get Nonce Step
 * Reads an address's mined (latest) and pending transaction counts via eth_getTransactionCount
 */
export async function getNonceStep(
  input: GetNonceInput
): Promise<GetNonceResult> {
  "use step";

  // Enrich input with address explorer link for the execution log
  const addressLink = await resolveExplorerLink(input.network, input.address);
  const enrichedInput: GetNonceInput & { addressLink?: string } = addressLink
    ? { ...input, addressLink }
    : input;

  return runPluginStep(
    { pluginName: "web3", actionName: "get-nonce" },
    enrichedInput,
    async () =>
      applyReadFailOnError(await stepHandler(input), input.failOnError, {
        nonce: null,
        latestNonce: null,
        pendingNonce: null,
        pendingCount: null,
        blockTag: requestedBlockTag(input.blockTag),
        address: input.address,
      })
  );
}

getNonceStep.maxRetries = 0;

export const _integrationType = "web3";
