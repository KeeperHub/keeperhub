/**
 * Executable step function for For Each (loop) action.
 *
 * This step logs the start of a For Each iteration cycle.
 * The actual iteration logic lives in the workflow executor, not here,
 * because the executor needs to orchestrate body-node execution per element.
 */
import "server-only";

import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

export type ForEachInput = StepInput & {
  arrayLength: number;
  maxIterations: number;
};

type ForEachResult = {
  success: true;
  arrayLength: number;
  maxIterations: number;
};

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function forEachStep(input: ForEachInput): Promise<ForEachResult> {
  "use step";
  return withStepLogging(input, () =>
    Promise.resolve({
      success: true as const,
      arrayLength: input.arrayLength,
      maxIterations: input.maxIterations,
    })
  );
}
forEachStep.maxRetries = 0;
