import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { BlockscoutCredentials } from "../credentials";
import { blockscoutGet } from "./blockscout-core";

type TransactionResponse = {
  hash?: string;
  status?: string;
  result?: string;
  value?: string;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  block_number?: number | null;
  fee?: { value?: string } | null;
  gas_used?: string | null;
  method?: string | null;
};

type GetTransactionResult =
  | {
      success: true;
      hash: string;
      status: string;
      value: string;
      from: string | null;
      to: string | null;
      blockNumber: number | null;
      fee: string | null;
      method: string | null;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type GetTransactionCoreInput = {
  txHash: string;
  network?: string;
};

export type GetTransactionInput = StepInput &
  GetTransactionCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetTransactionCoreInput,
  credentials: BlockscoutCredentials
): Promise<GetTransactionResult> {
  const txHash = input.txHash?.trim();
  if (!txHash) {
    return {
      success: false,
      error: "Transaction hash is required.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const result = await blockscoutGet<TransactionResponse>(
    `/api/v2/transactions/${encodeURIComponent(txHash)}`,
    credentials,
    input.network
  );

  if (!result.success) {
    return result;
  }

  const tx = result.data;
  return {
    success: true,
    hash: tx.hash ?? txHash,
    status: tx.status ?? tx.result ?? "unknown",
    value: tx.value ?? "0",
    from: tx.from?.hash ?? null,
    to: tx.to?.hash ?? null,
    blockNumber: tx.block_number ?? null,
    fee: tx.fee?.value ?? null,
    method: tx.method ?? null,
  };
}

export async function getTransactionStep(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "blockscout", actionName: "get-transaction" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "blockscout";
