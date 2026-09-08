import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type SpotDeployStateCoreInput = {
  user: string;
};

export type SpotDeployStateInput = StepInput & SpotDeployStateCoreInput;

async function stepHandler(
  input: SpotDeployStateCoreInput
): Promise<InfoResult> {
  if (!isEvmAddress(input.user)) {
    return {
      success: false,
      error: "User must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }

  return postInfo(
    { type: "spotDeployState", user: input.user },
    "spot-deploy-state"
  );
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function spotDeployStateStep(
  input: SpotDeployStateInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "spot-deploy-state" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
