import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type VaultDetailsCoreInput = {
  vaultAddress: string;
  user?: string;
};

export type VaultDetailsInput = StepInput & VaultDetailsCoreInput;

async function stepHandler(
  input: VaultDetailsCoreInput
): Promise<InfoResult> {
  if (!isEvmAddress(input.vaultAddress)) {
    return {
      success: false,
      error: "Vault address must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const body: Record<string, unknown> = {
    type: "vaultDetails",
    vaultAddress: input.vaultAddress,
  };
  if (input.user !== undefined && input.user !== "") {
    if (!isEvmAddress(input.user)) {
      return {
        success: false,
        error: "User must be a 0x-prefixed EVM address",
        errorClass: ExecutionErrorType.USER,
      };
    }
    body.user = input.user;
  }

  return postInfo(body, "vault-details");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function vaultDetailsStep(
  input: VaultDetailsInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "vault-details",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
