import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { DisburseCoreInput, DisburseResult } from "./disburse-core";
import { disburseCore } from "./disburse-core";

export type { DisburseCoreInput, DisburseResult } from "./disburse-core";

export type DisburseInput = StepInput & DisburseCoreInput;

/**
 * Disburse Step
 * Pays a list of recipients one leg at a time and records each leg under the
 * run key, so re-running a partly failed payout pays only the legs that did
 * not pay. The daily value cap is charged per leg inside the core, so the
 * standard runPluginStep epilogue applies here.
 */
export async function disburseStep(
  input: DisburseInput
): Promise<DisburseResult> {
  "use step";

  return await runPluginStep(
    { pluginName: "web3", actionName: "disburse" },
    input,
    disburseCore
  );
}

// Resuming is a new run under the same key; the step itself never retries.
disburseStep.maxRetries = 0;

export const _integrationType = "web3";
