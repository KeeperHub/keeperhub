import { z } from "zod";
import { MAX_DATE_EPOCH_MS, SAFE_CORRELATION_ID } from "./latency";

/**
 * Wire contract between the executor's warm pool (warm-pool.ts) and a warm
 * runner pod (lib/warm-pool-client.ts).
 *
 * A warm pod long-polls CLAIM_PATH on the executor replica that created it,
 * presenting the single-use token it was started with. The executor answers:
 *  - 200 + WarmAssignment: run this execution, then exit.
 *  - 204: nothing yet, poll again.
 *  - 410: the pod is no longer (or never was) part of this pool; exit.
 */

export const WARM_POOL_CLAIM_PATH = "/warm-pool/claim";
export const WARM_POOL_TOKEN_HEADER = "x-warm-pool-token";

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
 * The env a per-run Job carries for an execution (see k8s-job.ts), derived
 * from an assignment. A warm pod applies it after claiming so the runner and
 * its latency reporting behave exactly as they do in a per-run Job.
 */
export function assignmentToRunnerEnv(
  assignment: WarmAssignment
): Record<string, string> {
  const env: Record<string, string> = {
    WORKFLOW_ID: assignment.workflowId,
    EXECUTION_ID: assignment.executionId,
    WORKFLOW_INPUT: JSON.stringify(assignment.input),
    TRIGGER_TYPE: assignment.triggerType,
    KH_DISPATCH_TARGET: "warm-pool",
  };
  if (assignment.scheduleId) {
    env.SCHEDULE_ID = assignment.scheduleId;
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
  return env;
}
