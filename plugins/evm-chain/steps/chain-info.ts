import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { EvmChainCredentials } from "../credentials";
import { callEvmRpc, isHexResult } from "./evm-rpc-core";

type ChainInfoResult =
  | {
      success: true;
      chainId: string;
      chainIdDecimal: number;
      latestBlock: number;
    }
  | { success: false; error: string };

export type ChainInfoInput = StepInput & { integrationId?: string };

async function stepHandler(
  credentials: EvmChainCredentials
): Promise<ChainInfoResult> {
  const [idRes, blockRes] = await Promise.all([
    callEvmRpc(credentials, "eth_chainId", [], 1),
    callEvmRpc(credentials, "eth_blockNumber", [], 2),
  ]);

  if (!idRes.success) {
    return { success: false, error: idRes.error };
  }
  if (!blockRes.success) {
    return { success: false, error: blockRes.error };
  }

  const chainId = idRes.result;
  if (!isHexResult(chainId)) {
    return {
      success: false,
      error: `Unexpected chain id response: ${JSON.stringify(chainId)}`,
    };
  }

  const blockNumber = blockRes.result;
  if (!isHexResult(blockNumber)) {
    return {
      success: false,
      error: `Unexpected block response: ${JSON.stringify(blockNumber)}`,
    };
  }

  const latestBlock = Number.parseInt(blockNumber, 16);
  if (!Number.isFinite(latestBlock)) {
    return {
      success: false,
      error: `Unexpected block response: ${JSON.stringify(blockNumber)}`,
    };
  }

  return {
    success: true,
    chainId,
    chainIdDecimal: Number.parseInt(chainId, 16),
    latestBlock,
  };
}

export async function chainInfoStep(
  input: ChainInfoInput
): Promise<ChainInfoResult> {
  "use step";
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};
  return runPluginStep(
    { pluginName: "evm-chain", actionName: "chain-info" },
    input,
    () => stepHandler(credentials)
  );
}

export const _integrationType = "evm-chain";
