import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { BlockscoutCredentials } from "../credentials";
import { blockscoutGet } from "./blockscout-core";

type CountersResponse = {
  transactions_count?: string | null;
  token_transfers_count?: string | null;
  gas_usage_count?: string | null;
  validations_count?: string | null;
};

type GetAddressCountersResult =
  | {
      success: true;
      transactionsCount: string;
      tokenTransfersCount: string;
      gasUsageCount: string;
      validationsCount: string;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type GetAddressCountersCoreInput = {
  address: string;
  network?: string;
};

export type GetAddressCountersInput = StepInput &
  GetAddressCountersCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAddressCountersCoreInput,
  credentials: BlockscoutCredentials
): Promise<GetAddressCountersResult> {
  const address = input.address?.trim();
  if (!address) {
    return { success: false, error: "Address is required.", errorClass: ExecutionErrorType.USER };
  }

  const result = await blockscoutGet<CountersResponse>(
    `/api/v2/addresses/${encodeURIComponent(address)}/counters`,
    credentials,
    input.network
  );

  if (!result.success) {
    return result;
  }

  const c = result.data;
  return {
    success: true,
    transactionsCount: c.transactions_count ?? "0",
    tokenTransfersCount: c.token_transfers_count ?? "0",
    gasUsageCount: c.gas_usage_count ?? "0",
    validationsCount: c.validations_count ?? "0",
  };
}

export async function getAddressCountersStep(
  input: GetAddressCountersInput
): Promise<GetAddressCountersResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "blockscout", actionName: "get-address-counters" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "blockscout";
