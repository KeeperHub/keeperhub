/**
 * Executable step function for the Trip Circuit Breaker action.
 *
 * Engages the executing workflow's own org circuit breaker. From that moment
 * every value-moving workflow/protocol step in the org fails closed at the
 * value-ledger reservation gate and no new runs dispatch, until an admin/owner
 * clears it. The org is taken from the execution context, never from config, so
 * a workflow can only ever halt the org it runs under.
 */
import "server-only";

import { tripOrgCircuitBreaker } from "@/lib/execute/org-circuit-breaker";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

export type CircuitBreakerTripInput = StepInput & {
  /** Optional free-text incident note recorded on the org. */
  reason?: string;
};

type CircuitBreakerTripResult = {
  halted: true;
  // False when the breaker was already engaged (idempotent no-op).
  tripped: boolean;
  haltedAt: string;
};

type CircuitBreakerErrorResult = {
  success: false;
  error: string;
};

async function runTrip(
  input: CircuitBreakerTripInput
): Promise<CircuitBreakerTripResult | CircuitBreakerErrorResult> {
  const organizationId = input._context?.organizationId;
  if (!organizationId) {
    return {
      success: false,
      error: "Circuit breaker requires an organization context",
    };
  }

  const result = await tripOrgCircuitBreaker({
    organizationId,
    reason: input.reason ?? null,
    byWorkflowId: input._context?.workflowId ?? null,
  });

  return {
    halted: true,
    tripped: result.tripped,
    haltedAt: result.haltedAt.toISOString(),
  };
}

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function circuitBreakerTripStep(
  input: CircuitBreakerTripInput
): Promise<CircuitBreakerTripResult | CircuitBreakerErrorResult> {
  "use step";
  return withStepLogging(input, () => runTrip(input));
}
circuitBreakerTripStep.maxRetries = 0;
