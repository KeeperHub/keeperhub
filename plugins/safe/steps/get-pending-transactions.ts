import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { ethers } from "ethers";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import type { SafeCredentials } from "../credentials";

const PLUGIN_NAME = "safe";
const ACTION_NAME = "get-pending-transactions";
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

type SafeConfirmation = {
  owner: string;
  submissionDate: string;
  signature: string;
  signatureType: string;
};

type SafeMultisigTransaction = {
  safe: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  nonce: number;
  safeTxHash: string;
  submissionDate: string;
  executionDate: string | null;
  isExecuted: boolean;
  confirmationsRequired: number;
  confirmations: SafeConfirmation[];
  dataDecoded: unknown;
  gasToken: string;
  safeTxGas: number;
  baseGas: number;
  gasPrice: string;
  refundReceiver: string;
  origin: string | null;
};

type SafeApiResponse = {
  count: number;
  results: SafeMultisigTransaction[];
};

type SafeInfoResponse = {
  nonce: number;
};

type PendingTransaction = {
  safeTxHash: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  operationLabel: string;
  nonce: number;
  confirmations: SafeConfirmation[];
  confirmationsRequired: number;
  confirmationsCollected: number;
  dataDecoded: unknown;
  submissionDate: string;
  safe: string;
};

type GetPendingTransactionsResult =
  | { success: true; transactions: PendingTransaction[]; count: number }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type GetPendingTransactionsCoreInput = {
  safeAddress: string;
  network: string;
  signerAddress?: string;
};

export type GetPendingTransactionsInput = StepInput &
  GetPendingTransactionsCoreInput & {
    integrationId: string;
  };

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Map chain ID to Safe Transaction Service EIP-3770 chain slug.
 * Used with the unified API: https://api.safe.global/tx-service/{slug}/api/v1/
 */
function getSafeChainSlug(chainId: number): string | undefined {
  const slugMap: Record<number, string> = {
    1: "eth",
    10: "oeth",
    56: "bnb",
    100: "gno",
    137: "matic",
    8453: "base",
    42161: "arb1",
    42170: "arb-nova",
    43114: "avax",
    11155111: "sep",
    84532: "base-sep",
  };
  return slugMap[chainId];
}

async function stepHandler(
  input: GetPendingTransactionsCoreInput,
  credentials: SafeCredentials
): Promise<GetPendingTransactionsResult> {
  const apiKey = credentials.apiKey;

  if (!apiKey) {
    logUserError(
      ErrorCategory.CONFIGURATION,
      "[Safe] No API key provided in integration",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error:
        "Safe API key is required. Configure it in the integration settings.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!input.safeAddress) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Safe] No Safe address provided",
      undefined,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "Safe address is required",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const rawAddress = input.safeAddress.trim();
  if (!ETH_ADDRESS_REGEX.test(rawAddress)) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Safe] Invalid Safe address format",
      rawAddress,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: "Invalid Safe address format",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const address = ethers.getAddress(rawAddress);

  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Safe] Unsupported network",
      input.network,
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: `Unsupported network: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const chainSlug = getSafeChainSlug(chainId);
  if (!chainSlug) {
    logUserError(
      ErrorCategory.VALIDATION,
      "[Safe] Network not supported by Safe Transaction Service",
      { chainId, network: input.network },
      { plugin_name: PLUGIN_NAME, action_name: ACTION_NAME }
    );
    return {
      success: false,
      error: `Chain ID ${chainId} is not supported by the Safe Transaction Service`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const baseUrl = `https://api.safe.global/tx-service/${chainSlug}/api/v1/safes/${address}`;
  const txUrl = `${baseUrl}/multisig-transactions/?executed=false&trusted=true&ordering=-nonce&limit=100`;
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const [safeInfoResponse, txResponse] = await Promise.all([
      safeFetch(`${baseUrl}/`, {
        plugin: "safe",
        headers: authHeaders,
        redirect: "follow",
        signal: controller.signal,
      }),
      safeFetch(txUrl, {
        plugin: "safe",
        headers: authHeaders,
        redirect: "follow",
        signal: controller.signal,
      }),
    ]);

    clearTimeout(timeout);

    if (!txResponse.ok) {
      const errorBody = await txResponse.text().catch(() => "");
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Safe] API error",
        { status: txResponse.status, body: errorBody },
        {
          plugin_name: PLUGIN_NAME,
          action_name: ACTION_NAME,
          service: "safe-transaction-service",
        }
      );
      return {
        success: false,
        error: `Safe API returned HTTP ${txResponse.status}: ${errorBody}`,
        errorClass: txResponse.status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
      };
    }

    let currentNonce = 0;
    if (safeInfoResponse.ok) {
      const safeInfo = (await safeInfoResponse.json()) as SafeInfoResponse;
      currentNonce = safeInfo.nonce;
    }

    const data = (await txResponse.json()) as SafeApiResponse;
    let transactions = data.results.filter((tx) => tx.nonce >= currentNonce);

    // Filter for transactions the signer has NOT confirmed
    if (input.signerAddress) {
      const signer = input.signerAddress.trim().toLowerCase();
      transactions = transactions.filter(
        (tx) => !tx.confirmations.some((c) => c.owner.toLowerCase() === signer)
      );
    }

    const pending: PendingTransaction[] = transactions.map((tx) => ({
      safeTxHash: tx.safeTxHash,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      operationLabel: tx.operation === 1 ? "DELEGATECALL" : "CALL",
      nonce: tx.nonce,
      confirmations: tx.confirmations,
      confirmationsRequired: tx.confirmationsRequired,
      confirmationsCollected: tx.confirmations.length,
      dataDecoded: tx.dataDecoded,
      submissionDate: tx.submissionDate,
      safe: tx.safe,
    }));

    return { success: true, transactions: pending, count: pending.length };
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Safe] Error fetching pending transactions",
      error,
      {
        plugin_name: PLUGIN_NAME,
        action_name: ACTION_NAME,
        service: "safe-transaction-service",
      }
    );
    return {
      success: false,
      error: `Failed to fetch pending transactions: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function getPendingTransactionsStep(
  input: GetPendingTransactionsInput
): Promise<GetPendingTransactionsResult> {
  "use step";

  const credentials = await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null });

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => stepHandler(input, credentials)
  );
}
getPendingTransactionsStep.maxRetries = 0;

export const _integrationType = "safe";
