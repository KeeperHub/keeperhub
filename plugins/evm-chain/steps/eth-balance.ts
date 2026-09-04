import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";
import { callEvmRpc, isHexResult, toNative } from "./evm-rpc-core";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type EthBalanceResult =
  | {
      success: true;
      address: string;
      balanceWei: string;
      balanceNative: string;
    }
  | { success: false; error: string };

export type EthBalanceCoreInput = { address: string };

export type EthBalanceInput = StepInput &
  EthBalanceCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: EthBalanceCoreInput,
  credentials: EvmChainCredentials
): Promise<EthBalanceResult> {
  if (!ADDRESS_RE.test(input.address)) {
    return {
      success: false,
      error: "address must be a 20-byte hex address (0x... 40 hex chars)",
    };
  }

  const res = await callEvmRpc(credentials, "eth_getBalance", [
    input.address,
    "latest",
  ]);
  if (!res.success) {
    return { success: false, error: res.error };
  }

  const balanceWei = res.result;
  if (!isHexResult(balanceWei)) {
    return {
      success: false,
      error: `Unexpected balance response: ${JSON.stringify(balanceWei)}`,
    };
  }

  return {
    success: true,
    address: input.address,
    balanceWei,
    balanceNative: toNative(balanceWei),
  };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function ethBalanceStep(
  input: EthBalanceInput
): Promise<EthBalanceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "eth-balance" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "evm-chain";
