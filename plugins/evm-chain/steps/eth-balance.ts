import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";

type EthBalanceResult =
  | { success: true; address: string; balanceWei: string; balanceNative: string }
  | { success: false; error: string };

export type EthBalanceCoreInput = { address: string };

export type EthBalanceInput = StepInput &
  EthBalanceCoreInput & {
    integrationId?: string;
  };

function toNative(hexWei: string): string {
  const wei = BigInt(hexWei);
  const units = wei / BigInt(10) ** BigInt(18);
  const frac = wei % BigInt(10) ** BigInt(18);
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr ? `${units.toString()}. ${fracStr}`.replace(" .", ".") : units.toString();
}

async function stepHandler(
  input: EthBalanceCoreInput,
  credentials: EvmChainCredentials
): Promise<EthBalanceResult> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return {
      success: false,
      error: "EVM_CHAIN_RPC_URL is not configured. Add it in Project Integrations.",
    };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) {
    return { success: false, error: "address must be a 20-byte hex address (0x... 40 hex chars)" };
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [input.address, "latest"],
      }),
    });
    if (!response.ok) {
      return { success: false, error: `RPC endpoint returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    const balanceWei = payload?.result;
    if (typeof balanceWei !== "string" || !/^0x[0-9a-fA-F]+$/.test(balanceWei)) {
      return { success: false, error: `Unexpected balance response: ${JSON.stringify(payload)}` };
    }
    return {
      success: true,
      address: input.address,
      balanceWei,
      balanceNative: toNative(balanceWei),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function ethBalanceStep(input: EthBalanceInput): Promise<EthBalanceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "eth-balance" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "evm-chain";
