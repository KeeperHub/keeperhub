import "server-only";

import {
  runPluginStep,
  type StepInput,
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

  return runPluginStep(
    { pluginName: "hyperliquid", actionName: "validator-summaries" },
    input,
    () => stepHandler()
  );
}

export const _integrationType = "hyperliquid";
