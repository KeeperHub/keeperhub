import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";

type GasPriceResult =
  | { success: true; gasPriceWei: string }
  | { success: false; error: string };

export type GasPriceInput = StepInput & { integrationId?: string };

async function stepHandler(
  credentials: EvmChainCredentials
): Promise<GasPriceResult> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return {
      success: false,
      error: "EVM_CHAIN_RPC_URL is not configured. Add it in Project Integrations.",
    };
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
    });
    if (!response.ok) {
      return { success: false, error: `RPC endpoint returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    const gasPriceWei = payload?.result;
    if (typeof gasPriceWei !== "string" || !/^0x[0-9a-fA-F]+$/.test(gasPriceWei)) {
      return { success: false, error: `Unexpected gas price response: ${JSON.stringify(payload)}` };
    }
    return { success: true, gasPriceWei };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function gasPriceStep(input: GasPriceInput): Promise<GasPriceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "gas-price" },
    input,
    () => stepHandler(credentials)
  );
}

export const _integrationType = "evm-chain";
