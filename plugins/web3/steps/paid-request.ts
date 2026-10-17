import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type {
  PaidRequestCoreInput,
  PaidRequestResult,
} from "./paid-request-core";
import { paidRequestCore } from "./paid-request-core";

export type { PaidRequestResult } from "./paid-request-core";

export type PaidRequestInput = StepInput & PaidRequestCoreInput;

/**
 * Paid Request (x402) Step
 * Calls an endpoint and, when it answers 402, pays the quoted USDC on Base
 * from the org's Turnkey wallet and calls it again with the payment.
 */
export async function paidRequestStep(
  input: PaidRequestInput
): Promise<PaidRequestResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "paid-request" },
    input,
    paidRequestCore
  );
}

// A retry would sign and send a second payment for the same call.
paidRequestStep.maxRetries = 0;

export const _integrationType = "web3";
