/**
 * Executable step function for Collect action.
 *
 * Gathers results from a preceding For Each loop into an array.
 * The executor populates the results before calling this step so that
 * the execution is properly logged.
 */
import "server-only";

import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

export type CollectInput = StepInput & {
  results: unknown[];
  count: number;
};

type CollectResult = {
  results: unknown[];
  count: number;
};

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function collectStep(input: CollectInput): Promise<CollectResult> {
  "use step";
  return withStepLogging(input, () =>
    Promise.resolve({
      results: input.results,
      count: input.count,
    })
  );
}
collectStep.maxRetries = 0;
