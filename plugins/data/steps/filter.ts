import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  type FilterCoreInput,
  type FilterResult,
  filterArray,
} from "./filter-core";

const PLUGIN_NAME = "data";
const ACTION_NAME = "filter";

export type { FilterCoreInput, FilterResult };

export type FilterInput = StepInput & FilterCoreInput;

export async function filterStep(input: FilterInput): Promise<FilterResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(filterArray(input))
  );
}

filterStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
