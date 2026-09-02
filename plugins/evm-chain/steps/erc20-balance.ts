import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";

type Erc20BalanceResult =
  | { success: true; token: string; holder: string; balance: string }
  | { success: false; error: string };

export type Erc20BalanceCoreInput = { token: string; holder: string };

export type Erc20BalanceInput = StepInput &
  Erc20BalanceCoreInput & {
    integrationId?: string;
  };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function stepHandler(
  input: Erc20BalanceCoreInput,
  credentials: EvmChainCredentials
): Promise<Erc20BalanceResult> {
  const rpcUrl = credentials.EVM_CHAIN_RPC_URL;
  if (!rpcUrl) {
    return {
      success: false,
      error: "EVM_CHAIN_RPC_URL is not configured. Add it in Project Integrations.",
    };
  }
  if (!ADDRESS_RE.test(input.token)) {
    return { success: false, error: "token must be a 20-byte hex address (0x... 40 hex chars)" };
  }
  if (!ADDRESS_RE.test(input.holder)) {
    return { success: false, error: "holder must be a 20-byte hex address (0x... 40 hex chars)" };
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: input.token,
            data: "0x70a08231" + input.holder.toLowerCase().replace(/^0x/, "").padStart(64, "0"),
          },
          "latest",
        ],
      }),
    });
    if (!response.ok) {
      return { success: false, error: `RPC endpoint returned HTTP ${response.status}` };
    }
    const payload = await response.json();
    const data = payload?.result;
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/i.test(data) || data.length < 66) {
      return { success: false, error: `Unexpected balanceOf response: ${JSON.stringify(payload)}` };
    }
    return {
      success: true,
      token: input.token,
      holder: input.holder,
      balance: BigInt(data).toString(),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function erc20BalanceStep(input: Erc20BalanceInput): Promise<Erc20BalanceResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, { organizationId: input._context?.organizationId ?? null })
    : {};

  return runPluginStep(
    { pluginName: "evm-chain", actionName: "erc20-balance" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "evm-chain";
