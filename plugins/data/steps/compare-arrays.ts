import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  type CompareArraysCoreInput,
  type CompareArraysResult,
  compareArrays,
} from "./compare-arrays-core";

const PLUGIN_NAME = "data";
const ACTION_NAME = "compare-arrays";

export type { CompareArraysCoreInput, CompareArraysResult };

export type CompareArraysInput = StepInput & CompareArraysCoreInput;

export async function compareArraysStep(
  input: CompareArraysInput
): Promise<CompareArraysResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(compareArrays(input))
  );
}

compareArraysStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
