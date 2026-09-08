/**
 * Executable step function for the Reset Circuit Breaker action.
 *
 * Clears the executing workflow's own org circuit breaker so runs resume. This
 * is privileged: it succeeds only when the workflow's creator is a current
 * admin/owner of the org. A workflow created by a non-admin (or whose creator
 * was later demoted) cannot auto-reset, and the denial fails the step loudly
 * rather than silently leaving the breaker engaged.
 */
import "server-only";

import { resetOrgCircuitBreaker } from "@/lib/execute/org-circuit-breaker";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

export type CircuitBreakerResetInput = StepInput;

type CircuitBreakerResetResult = {
  reset: true;
  // False when the breaker was not engaged (idempotent no-op).
  wasHalted: boolean;
};

type CircuitBreakerErrorResult = {
  success: false;
  error: string;
};

async function runReset(
  input: CircuitBreakerResetInput
): Promise<CircuitBreakerResetResult | CircuitBreakerErrorResult> {
  const organizationId = input._context?.organizationId;
  if (!organizationId) {
    return {
      success: false,
      error: "Circuit breaker requires an organization context",
    };
  }

  const result = await resetOrgCircuitBreaker({
    organizationId,
    requestedByUserId: input._context?.createdBy,
  });

  if (!result.reset) {
    return {
      success: false,
      error:
        "Only a workflow created by an organization admin or owner can reset the circuit breaker",
    };
  }

  return { reset: true, wasHalted: result.wasHalted };
}

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function circuitBreakerResetStep(
  input: CircuitBreakerResetInput
): Promise<CircuitBreakerResetResult | CircuitBreakerErrorResult> {
  "use step";
  return withStepLogging(input, () => runReset(input));
}
circuitBreakerResetStep.maxRetries = 0;
