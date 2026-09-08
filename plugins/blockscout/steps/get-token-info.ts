import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { BlockscoutCredentials } from "../credentials";
import { blockscoutGet } from "./blockscout-core";

type TokenResponse = {
  address_hash?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  total_supply?: string | null;
  type?: string | null;
  holders_count?: string | null;
  holders?: string | null;
};

type GetTokenInfoResult =
  | {
      success: true;
      address: string;
      name: string | null;
      symbol: string | null;
      decimals: string | null;
      totalSupply: string | null;
      type: string | null;
      holders: string | null;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
    };

export type GetTokenInfoCoreInput = {
  tokenAddress: string;
  network?: string;
};

export type GetTokenInfoInput = StepInput &
  GetTokenInfoCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetTokenInfoCoreInput,
  credentials: BlockscoutCredentials
): Promise<GetTokenInfoResult> {
  const tokenAddress = input.tokenAddress?.trim();
  if (!tokenAddress) {
    return {
      success: false,
      error: "Token address is required.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const result = await blockscoutGet<TokenResponse>(
    `/api/v2/tokens/${encodeURIComponent(tokenAddress)}`,
    credentials,
    input.network
  );

  if (!result.success) {
    return result;
  }

  const token = result.data;
  return {
    success: true,
    address: token.address_hash ?? tokenAddress,
    name: token.name ?? null,
    symbol: token.symbol ?? null,
    decimals: token.decimals ?? null,
    totalSupply: token.total_supply ?? null,
    type: token.type ?? null,
    holders: token.holders_count ?? token.holders ?? null,
  };
}

export async function getTokenInfoStep(
  input: GetTokenInfoInput
): Promise<GetTokenInfoResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "blockscout", actionName: "get-token-info" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "blockscout";
