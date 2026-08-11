import "server-only";

import { NextResponse } from "next/server";
import { isBillingEnabled } from "./feature-flag";
import { checkExecutionLimit, type ExecutionLimitResult } from "./plans-server";

type GuardAllowed = {
  blocked: false;
  limitResult: ExecutionLimitResult | null;
};

type GuardBlocked = {
  blocked: true;
  response: NextResponse;
};

export type ExecutionGuardResult = GuardAllowed | GuardBlocked;

export const EXECUTION_LIMIT_ERROR = "Monthly execution limit exceeded";
export const EXECUTION_DEBT_ERROR =
  "Executions suspended due to unpaid overage invoice. Please update your payment method.";

/**
 * Enforce execution limits for a given organization.
 *
 * - Returns `{ blocked: false }` if billing is disabled or org is null.
 * - Returns `{ blocked: false }` if within limits or overage is enabled (billed later).
 * - Returns `{ blocked: true, response }` with 429 if free plan limit exceeded.
 *
 * NOTE: This is a soft limit (check-then-act, not atomic). Under concurrent load,
 * a small number of executions may exceed the limit, bounded by request concurrency.
 * For paid plans, the overage billing system acts as the backstop.
 * For free plans, the overshoot is bounded and acceptable.
 */
export async function enforceExecutionLimit(
  organizationId: string | null | undefined
): Promise<ExecutionGuardResult> {
  if (!isBillingEnabled()) {
    return { blocked: false, limitResult: null };
  }

  if (organizationId === null || organizationId === undefined) {
    return { blocked: false, limitResult: null };
  }

  const result = await checkExecutionLimit(organizationId);

  if (result.allowed) {
    return { blocked: false, limitResult: result };
  }

  const hasDebt = result.debtExecutions > 0;

  return {
    blocked: true,
    response: NextResponse.json(
      {
        error: hasDebt ? EXECUTION_DEBT_ERROR : EXECUTION_LIMIT_ERROR,
        limit: result.limit,
        used: result.used,
        plan: result.plan,
      },
      { status: 429 }
    ),
  };
}
