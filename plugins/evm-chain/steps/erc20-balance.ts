import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";
import { callEvmRpc, isHexResult } from "./evm-rpc-core";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_PREFIX_RE = /^0x/;
const BALANCE_OF_SELECTOR = "0x70a08231";

type Erc20BalanceResult =
  | {
      success: true;
      token: string;
      holder: string;
      balance: string;
    }
  | { success: false; error: string };

export type Erc20BalanceCoreInput = { token: string; holder: string };

export type Erc20BalanceInput = StepInput &
  Erc20BalanceCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: Erc20BalanceCoreInput,
  credentials: EvmChainCredentials
): Promise<Erc20BalanceResult> {
  if (!ADDRESS_RE.test(input.token)) {
    return {
      success: false,
      error: "token must be a 20-byte hex address (0x... 40 hex chars)",
    };
  }
  if (!ADDRESS_RE.test(input.holder)) {
    return {
      success: false,
      error: "holder must be a 20-byte hex address (0x... 40 hex chars)",
    };
  }

  const data =
    BALANCE_OF_SELECTOR +
    input.holder.toLowerCase().replace(HEX_PREFIX_RE, "").padStart(64, "0");

  const res = await callEvmRpc(credentials, "eth_call", [
    { to: input.token, data },
    "latest",
  ]);
  if (!res.success) {
    return { success: false, error: res.error };
  }

  const raw = res.result;
  if (!isHexResult(raw) || raw.length < 66) {
    return {
      success: false,
      error: `Unexpected balanceOf response: ${JSON.stringify(raw)}`,
    };
  }

  return {
    success: true,
    token: input.token,
    holder: input.holder,
    balance: BigInt(raw).toString(),
  };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function erc20BalanceStep(
  input: Erc20BalanceInput
): Promise<Erc20BalanceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "erc20-balance" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "evm-chain";
