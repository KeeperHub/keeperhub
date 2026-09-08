import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";
import { callEvmRpc, isHexResult } from "./evm-rpc-core";

type GasPriceResult =
  | { success: true; gasPriceWei: string }
  | { success: false; error: string };

export type GasPriceInput = StepInput & { integrationId?: string };

async function stepHandler(
  credentials: EvmChainCredentials
): Promise<GasPriceResult> {
  const res = await callEvmRpc(credentials, "eth_gasPrice");
  if (!res.success) {
    return { success: false, error: res.error };
  }

  const gasPriceWei = res.result;
  if (!isHexResult(gasPriceWei)) {
    return {
      success: false,
      error: `Unexpected gas price response: ${JSON.stringify(gasPriceWei)}`,
    };
  }

  return { success: true, gasPriceWei };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function gasPriceStep(
  input: GasPriceInput
): Promise<GasPriceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "gas-price" },
    input,
    () => stepHandler(credentials)
  );
}

export const _integrationType = "evm-chain";
