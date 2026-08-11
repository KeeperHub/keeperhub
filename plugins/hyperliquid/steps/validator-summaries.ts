import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import { type InfoResult, postInfo } from "./info-request-core";

export type ValidatorSummariesCoreInput = Record<string, never>;

export type ValidatorSummariesInput = StepInput & ValidatorSummariesCoreInput;

function stepHandler(): Promise<InfoResult> {
  return postInfo({ type: "validatorSummaries" }, "validator-summaries");
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function validatorSummariesStep(
  input: ValidatorSummariesInput
): Promise<InfoResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "hyperliquid",
      actionName: "validator-summaries",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => stepHandler())
  );
}

export const _integrationType = "hyperliquid";
