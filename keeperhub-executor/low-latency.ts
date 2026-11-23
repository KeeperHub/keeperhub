import {
  getWorkflowExecutionPriority,
  LOW_LATENCY_DISPATCH_TRIGGERS,
} from "../lib/workflow/execution-priority";
import { isSafeCorrelationId } from "./latency";
import type { WarmAssignResult } from "./warm-pool";
import type { WarmAssignment } from "./warm-pool-protocol";

/**
 * Routing for the low-latency start: whether a run may try the warm pool, and
 * handing it over. Kept free of the executor's process state so every rule is
 * unit-tested (low-latency.test.ts); index.ts supplies the pool, the plan
 * lookup and the metrics.
 */

export type ClaimOutcome = WarmAssignResult | "not_entitled";

/** A run cleared to try the warm pool, and the labels its claim reports. */
export type LowLatencyStart = {
  organizationId: string;
  /** The message trigger type (webhook stays "webhook"), for metrics. */
  triggerType: string;
};

/**
 * A run may try the warm pool only when all of these hold; anything else is
 * the standard start, and none of them can block or fail the run:
 *  - it would otherwise get its own Job (k8s-job target) and a pool is running
 *  - it was started by an automated trigger, never manually or by API, so
 *    repeated manual runs cannot drain the pool
 *  - the workflow asks for a low-latency start
 *  - its organization's plan includes it; a failed check counts as "no"
 */
export async function resolveLowLatencyStart(params: {
  nodes: readonly unknown[];
  organizationId: string | null | undefined;
  target: string;
  triggerType: string;
  poolEnabled: boolean;
  isEntitled: (organizationId: string) => Promise<boolean>;
  recordClaim: (result: ClaimOutcome, triggerType: string) => void;
  onEntitlementError: (error: unknown) => void;
}): Promise<LowLatencyStart | undefined> {
  const { organizationId, triggerType } = params;
  if (
    params.target !== "k8s-job" ||
    !params.poolEnabled ||
    !organizationId ||
    !LOW_LATENCY_DISPATCH_TRIGGERS.has(triggerType) ||
    getWorkflowExecutionPriority(params.nodes) !== "low-latency"
  ) {
    return undefined;
  }

  let entitled: boolean;
  try {
    entitled = await params.isEntitled(organizationId);
  } catch (error) {
    params.onEntitlementError(error);
    return undefined;
  }
  if (!entitled) {
    params.recordClaim("not_entitled", triggerType);
    return undefined;
  }
  return { organizationId, triggerType };
}

/**
 * The assignment a warm pod receives. A correlation id that could not go on a
 * per-run Job (see isSafeCorrelationId) is dropped here too.
 */
export function buildWarmAssignment(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
  triggerType: string;
  scheduleId?: string;
  correlationId?: string;
  receivedAt?: number;
  observedAt?: number;
}): WarmAssignment {
  const { correlationId, ...rest } = params;
  return {
    ...rest,
    correlationId:
      correlationId && isSafeCorrelationId(correlationId)
        ? correlationId
        : undefined,
  };
}

/**
 * Try to hand the run to a warm pod. Returns undefined when the run was not
 * cleared for it; otherwise the pool's answer, already counted. Anything but
 * "claimed" means the caller creates a per-run Job.
 */
export function tryWarmStart(params: {
  pool: { tryAssign(a: WarmAssignment, org: string): WarmAssignResult } | undefined;
  start: LowLatencyStart | undefined;
  assignment: WarmAssignment;
  recordClaim: (result: ClaimOutcome, triggerType: string) => void;
}): WarmAssignResult | undefined {
  const { pool, start } = params;
  if (!(pool && start)) {
    return undefined;
  }
  const result = pool.tryAssign(params.assignment, start.organizationId);
  params.recordClaim(result, start.triggerType);
  return result;
}
