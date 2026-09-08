import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type ClearinghouseStateCoreInput = {
  user: string;
  dex?: string;
};

export type ClearinghouseStateInput = StepInput & ClearinghouseStateCoreInput;

async function stepHandler(
  input: ClearinghouseStateCoreInput
): Promise<InfoResult> {
  if (!isEvmAddress(input.user)) {
    return {
      success: false,
      error: "User must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }

  const body: Record<string, unknown> = {
    type: "clearinghouseState",
    user: input.user,
  };
  if (input.dex) {
    body.dex = input.dex;
  }

  return postInfo(body, "clearinghouse-state");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function clearinghouseStateStep(
  input: ClearinghouseStateInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "clearinghouse-state" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
