/**
 * Executable step function for Condition action
 */
import "server-only";

import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

export type ConditionInput = StepInput & {
  condition: boolean;
  /** Original condition expression string for logging (e.g., "{{@nodeId:Label.field}} === 'good'") */
  expression?: string;
  /** Expression with each reference replaced by its resolved value (e.g., "\"0x1...\" == \"0x6...\"") */
  resolvedExpression?: string;
  /** Resolved values of template variables for logging (e.g., { "Label.field": "actual_value" }) */
  values?: Record<string, unknown>;
  /** KEEP-1284: Error from condition evaluation - if set, the step will throw */
  _evaluationError?: string;
  /**
   * Field paths that were not present on their node's output and resolved to
   * undefined. Logged with the step so a mistyped reference is still visible
   * in the run even though it no longer fails the branch.
   */
  unresolvedFields?: string[];
};

type ConditionResult = {
  condition: boolean;
};

type ConditionErrorResult = {
  success: false;
  error: string;
};

function evaluateCondition(
  input: ConditionInput
): ConditionResult | ConditionErrorResult {
  // KEEP-1284: Return error result so step is properly logged as failed
  if (input._evaluationError) {
    return { success: false, error: input._evaluationError };
  }
  return { condition: input.condition };
}

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function conditionStep(
  input: ConditionInput
): Promise<ConditionResult | ConditionErrorResult> {
  "use step";
  return withStepLogging(input, () =>
    Promise.resolve(evaluateCondition(input))
  );
}
conditionStep.maxRetries = 0;
