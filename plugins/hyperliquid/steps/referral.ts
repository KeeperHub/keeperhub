import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, isEvmAddress, postInfo } from "./info-request-core";

export type ReferralCoreInput = {
  user: string;
};

export type ReferralInput = StepInput & ReferralCoreInput;

async function stepHandler(input: ReferralCoreInput): Promise<InfoResult> {
  if (!isEvmAddress(input.user)) {
    return {
      success: false,
      error: "User must be a 0x-prefixed EVM address",
      errorClass: ExecutionErrorType.USER,
    };
  }

  return postInfo({ type: "referral", user: input.user }, "referral");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function referralStep(
  input: ReferralInput
): Promise<InfoResult> {
  "use step";

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "referral" },
    input,
    stepHandler
  );
}

export const _integrationType = "hyperliquid";
