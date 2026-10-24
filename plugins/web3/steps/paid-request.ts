import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import type {
  PaidRequestCoreInput,
  PaidRequestResult,
} from "./paid-request-core";
import { paidRequestCore } from "./paid-request-core";

export type { PaidRequestCoreInput, PaidRequestResult } from "./paid-request-core";

export type PaidRequestInput = StepInput & PaidRequestCoreInput;

/**
 * Paid Request (x402) Step
 * Calls an HTTP endpoint; when it answers 402, pays the quoted USDC on Base
 * from the org's Turnkey wallet and retries with the payment. Free responses
 * pass through without signing.
 */
export async function paidRequestStep(
  input: PaidRequestInput
): Promise<PaidRequestResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "paid-request",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => paidRequestCore(input))
  );
}

// A retryable-looking failure after the payment signature is produced (a
// reset once the facilitator settled the authorization) would be charged
// twice, so this step must never be retried.
paidRequestStep.maxRetries = 0;

export const _integrationType = "web3";
