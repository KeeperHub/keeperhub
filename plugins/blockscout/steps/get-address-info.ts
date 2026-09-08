import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { BlockscoutCredentials } from "../credentials";
import { blockscoutGet } from "./blockscout-core";

type AddressInfoResponse = {
  hash?: string;
  coin_balance?: string | null;
  exchange_rate?: string | null;
  is_scam?: boolean;
  is_verified?: boolean;
  is_contract?: boolean;
  reputation?: string | null;
  ens_domain_name?: string | null;
  proxy_type?: string | null;
  public_tags?: unknown[] | null;
  has_token_transfers?: boolean;
  has_tokens?: boolean;
  has_logs?: boolean;
  block_number_balance_updated_at?: number | null;
};

type GetAddressInfoResult =
  | {
      success: true;
      address: string;
      coinBalance: string;
      exchangeRate: string | null;
      isScam: boolean;
      isVerified: boolean;
      isContract: boolean;
      reputation: string | null;
      ensName: string | null;
      proxyType: string | null;
      publicTags: unknown[];
      hasTokenTransfers: boolean;
      hasTokens: boolean;
      hasLogs: boolean;
      blockNumberBalanceUpdatedAt: number | null;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type GetAddressInfoCoreInput = {
  address: string;
  network?: string;
};

export type GetAddressInfoInput = StepInput &
  GetAddressInfoCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAddressInfoCoreInput,
  credentials: BlockscoutCredentials
): Promise<GetAddressInfoResult> {
  const address = input.address?.trim();
  if (!address) {
    return { success: false, error: "Address is required.", errorClass: ExecutionErrorType.USER };
  }

  const result = await blockscoutGet<AddressInfoResponse>(
    `/api/v2/addresses/${encodeURIComponent(address)}`,
    credentials,
    input.network
  );

  if (!result.success) {
    return result;
  }

  const a = result.data;
  return {
    success: true,
    address: a.hash ?? address,
    coinBalance: a.coin_balance ?? "0",
    exchangeRate: a.exchange_rate ?? null,
    isScam: a.is_scam ?? false,
    isVerified: a.is_verified ?? false,
    isContract: a.is_contract ?? false,
    reputation: a.reputation ?? null,
    ensName: a.ens_domain_name ?? null,
    proxyType: a.proxy_type ?? null,
    publicTags: a.public_tags ?? [],
    hasTokenTransfers: a.has_token_transfers ?? false,
    hasTokens: a.has_tokens ?? false,
    hasLogs: a.has_logs ?? false,
    blockNumberBalanceUpdatedAt: a.block_number_balance_updated_at ?? null,
  };
}

export async function getAddressInfoStep(
  input: GetAddressInfoInput
): Promise<GetAddressInfoResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "blockscout", actionName: "get-address-info" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "blockscout";
