import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";

type ChainInfoResult =
  | { success: true; chainId: string; chainIdDecimal: number; latestBlock: number }
  | { success: false; error: string };

export type ChainInfoInput = StepInput & { integrationId?: string };

/** Core chain-info logic - receives credentials as parameter. */
async function stepHandler(
  credentials: EvmChainCredentials
): Promise<ChainInfoResult> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return {
      success: false,
      error: "EVM_CHAIN_RPC_URL is not configured. Add it in Project Integrations.",
    };
  }
  const rpc = async (id: number, method: string): Promise<unknown> => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
    });
    if (!response.ok) throw new Error(`RPC endpoint returned HTTP ${response.status}`);
    return response.json();
  };
  try {
    const [idRes, blockRes] = await Promise.all([rpc(1, "eth_chainId"), rpc(2, "eth_blockNumber")]);
    const chainId = (idRes as { result?: unknown })?.result;
    if (typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId)) {
      return { success: false, error: `Unexpected chain id response: ${JSON.stringify(idRes)}` };
    }
    const latestBlock = Number.parseInt(String((blockRes as { result?: unknown })?.result), 16);
    if (!Number.isFinite(latestBlock)) {
      return { success: false, error: `Unexpected block response: ${JSON.stringify(blockRes)}` };
    }
    return {
      success: true,
      chainId,
      chainIdDecimal: Number.parseInt(chainId, 16),
      latestBlock,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function chainInfoStep(input: ChainInfoInput): Promise<ChainInfoResult> {
  "use step";
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};
  return runPluginStep(
    { pluginName: "evm-chain", actionName: "chain-info" },
    input,
    () => stepHandler(credentials)
  );
}

export const _integrationType = "evm-chain";
