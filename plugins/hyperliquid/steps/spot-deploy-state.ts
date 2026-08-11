import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
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

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "spot-deploy-state",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler(input))
  );
}

export const _integrationType = "hyperliquid";
