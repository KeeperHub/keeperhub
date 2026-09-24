import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  calculateTreasuryRunway,
  type TreasuryRunwayCoreInput,
  type TreasuryRunwaySuccess,
} from "./treasury-runway-core";

const PLUGIN_NAME = "math";
const ACTION_NAME = "treasury-runway";

export type TreasuryRunwayInput = StepInput & TreasuryRunwayCoreInput;

export type TreasuryRunwayResult =
  | TreasuryRunwaySuccess
  | { success: false; error: string; errorClass?: ExecutionErrorType };

function failed(error: string): TreasuryRunwayResult {
  return {
    success: false,
    error,
    errorClass: ExecutionErrorType.USER,
  };
}

function stepHandler(
  input: TreasuryRunwayCoreInput
): TreasuryRunwayResult {
  try {
    return calculateTreasuryRunway(input);
  } catch (error) {
    return failed(`Treasury runway calculation failed: ${getErrorMessage(error)}`);
  }
}

export async function treasuryRunwayStep(
  input: TreasuryRunwayInput
): Promise<TreasuryRunwayResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => Promise.resolve(stepHandler(input))
  );
}

treasuryRunwayStep.maxRetries = 0;

export const _integrationType = PLUGIN_NAME;
