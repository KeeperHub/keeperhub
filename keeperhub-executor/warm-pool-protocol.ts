import { z } from "zod";
import {
  isSafeCorrelationId,
  MAX_DATE_EPOCH_MS,
  SAFE_CORRELATION_ID,
} from "./latency";

/**
 * Wire contract between the executor's warm pool (warm-pool.ts) and a warm
 * runner pod (lib/warm-pool-client.ts).
 *
 * A warm pod long-polls CLAIM_PATH on the executor replica that created it,
 * presenting the single-use token it was started with. The executor answers:
 *  - 200 + WarmAssignment: this execution is offered; acknowledge it (below).
 *  - 204: nothing yet, poll again.
 *  - 410: the pod is no longer (or never was) part of this pool; exit.
 */

export const WARM_POOL_CLAIM_PATH = "/warm-pool/claim";
export const WARM_POOL_TOKEN_HEADER = "x-warm-pool-token";

/**
 * After receiving an assignment the pod checks it against the database and
 * answers on ACK_PATH with the execution id and its decision. It runs the
 * execution only if the executor answers 200 to an "accept". The executor
 * waits a short time for that answer; with no answer, or a "refuse", it
 * starts a per-run Job instead and any later ack gets 410. The executor
 * confirms at most one of the two, so a run is never started twice.
 */
export const WARM_POOL_ACK_PATH = "/warm-pool/ack";
export const WARM_POOL_EXECUTION_HEADER = "x-warm-pool-execution";
export const WARM_POOL_DECISION_HEADER = "x-warm-pool-decision";
export type WarmAckDecision = "accept" | "refuse";

/**
 * How long the executor waits for an ack after offering an execution. The
 * pod waits longer for the answer to its ack (it sends the ack after the
 * offer, so its deadline always falls after the executor's): any 200 the
 * executor sends is sent while the pod is still listening, and only a real
 * network drop can lose it.
 */
export const WARM_POOL_ACK_WINDOW_MS = 3000;
export const WARM_POOL_ACK_REQUEST_TIMEOUT_MS = WARM_POOL_ACK_WINDOW_MS + 2000;

// Runner env vars that turn a runner into a warm pod (set on warm Jobs only).
export const WARM_POOL_ENV = {
  claimUrl: "KH_WARM_POOL_CLAIM_URL",
  token: "KH_WARM_POOL_TOKEN",
  maxIdleMs: "KH_WARM_POOL_MAX_IDLE_MS",
  runDeadlineMs: "KH_WARM_POOL_RUN_DEADLINE_MS",
  preloadActionPrefixes: "KH_WARM_POOL_PRELOAD_ACTION_PREFIXES",
} as const;

export const warmAssignmentSchema = z.object({
  workflowId: z.string().min(1),
  executionId: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  triggerType: z.string().min(1),
  scheduleId: z.string().min(1).optional(),
  // Same bounds as the SQS message schema: these become runner env and log
  // fields, so the producer contract is enforced at this boundary too.
  correlationId: z.string().regex(SAFE_CORRELATION_ID).optional(),
  receivedAt: z.number().safe().gte(0).lte(MAX_DATE_EPOCH_MS).optional(),
  observedAt: z.number().safe().gte(0).lte(MAX_DATE_EPOCH_MS).optional(),
});

export type WarmAssignment = z.infer<typeof warmAssignmentSchema>;

/**
 * What an execution needs to run, whether it starts in a per-run Job or a
 * warm pod. A correlation id that could not go on a Job (see
 * isSafeCorrelationId) is dropped here, once, for both paths.
 */
export function buildRunAssignment(params: {
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
 * The runner env for an execution: the single source for both start paths.
 * A per-run Job carries it from creation (k8s-job.ts); a warm pod applies it
 * after its claim is confirmed, so the runner and its latency reporting
 * behave the same either way. KH_DISPATCH_TARGET marks a warm start; its
 * absence means a per-run Job.
 */
export function assignmentToRunnerEnv(
  assignment: WarmAssignment,
  dispatchTarget: "warm-pool" | "k8s-job"
): Record<string, string> {
  const env: Record<string, string> = {
    WORKFLOW_ID: assignment.workflowId,
    EXECUTION_ID: assignment.executionId,
    WORKFLOW_INPUT: JSON.stringify(assignment.input),
    TRIGGER_TYPE: assignment.triggerType,
  };
  if (dispatchTarget === "warm-pool") {
    env.KH_DISPATCH_TARGET = "warm-pool";
  }
  if (assignment.correlationId) {
    env.KH_CORRELATION_ID = assignment.correlationId;
  }
  if (assignment.receivedAt !== undefined) {
    env.KH_RECEIVED_AT = String(assignment.receivedAt);
  }
  if (assignment.observedAt !== undefined) {
    env.KH_OBSERVED_AT = String(assignment.observedAt);
  }
  if (assignment.scheduleId) {
    env.SCHEDULE_ID = assignment.scheduleId;
  }
  return env;
}
