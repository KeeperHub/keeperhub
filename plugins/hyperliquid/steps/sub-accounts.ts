import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type SubAccountsCoreInput = {
  user: string;
};

export type SubAccountsInput = StepInput & SubAccountsCoreInput;

async function stepHandler(input: SubAccountsCoreInput): Promise<InfoResult> {
  if (!isEvmAddress(input.user)) {
    return {
      success: false,
      error: "Master address must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }

  return postInfo({ type: "subAccounts", user: input.user }, "sub-accounts");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function subAccountsStep(
  input: SubAccountsInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "sub-accounts" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
