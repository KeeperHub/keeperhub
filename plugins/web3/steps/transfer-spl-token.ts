import "server-only";

import { withStepValueCap } from "@/lib/execute/value-ledger";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type {
  TransferSplTokenCoreInput,
  TransferSplTokenResult,
} from "./transfer-spl-token-core";
import { transferSplTokenCore } from "./transfer-spl-token-core";

export type {
  TransferSplTokenCoreInput,
  TransferSplTokenResult,
} from "./transfer-spl-token-core";

export type TransferSplTokenInput = StepInput & TransferSplTokenCoreInput;

/**
 * Transfer SPL Token Step
 * Transfers SPL tokens on Solana from the organization wallet to a recipient.
 */
export async function transferSplTokenStep(
  input: TransferSplTokenInput
): Promise<TransferSplTokenResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "transfer-spl-token",
      executionId: input._context?.executionId,
    },
    () =>
      withStepLogging(input, () =>
        withStepValueCap(
          {
            organizationId: input._context?.organizationId,
            stepFunction: "transferSplTokenStep",
            config: { network: input.network },
            executionId: input._context?.executionId,
            valueCapReserved: input._context?.valueCapReserved,
          },
          () => transferSplTokenCore(input)
        )
      )
  );
}

transferSplTokenStep.maxRetries = 0;

export const _integrationType = "web3";
