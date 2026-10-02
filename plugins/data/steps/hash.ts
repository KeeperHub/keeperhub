import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import { type HashCoreInput, type HashResult, hashValues } from "./hash-core";

const PLUGIN_NAME = "data";
const ACTION_NAME = "hash";

export type { HashCoreInput, HashResult };

export type HashInput = StepInput & HashCoreInput;

export async function hashStep(input: HashInput): Promise<HashResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(hashValues(input))
  );
}

hashStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
