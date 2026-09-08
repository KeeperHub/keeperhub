/**
 * Executable step function for the State Set action (KEEP-1036, #2288).
 *
 * Writes one key to the executing workflow's own persistent state. The write
 * is an atomic upsert; with `expectedVersion` (from State Get) it is a
 * compare-and-set, so two overlapping executions of the same workflow can
 * safely do read-modify-write on a shared cursor. Size, key-count, and TTL
 * limits are enforced here - over-limit writes fail as structured step
 * errors, not documented promises.
 */
import "server-only";

import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  coerceStateValue,
  resolveExpectedVersion,
  resolveTtlSeconds,
  setWorkflowStateValue,
  type WorkflowStateScope,
} from "@/lib/workflow/nodes/workflow-state/store";

export type StateSetInput = StepInput & {
  key?: string;
  value?: unknown;
  // Seconds until the key expires. Number (MCP) or numeric string (editor).
  ttl?: number | string;
  // Compare-and-set: only write if the key's current version matches.
  expectedVersion?: number | string;
};

type StateSetResult =
  | { success: true; created: boolean; version: number }
  | { success: false; error: string };

/**
 * Resolve the (org, workflow) scope from the execution context. Config values
 * named organizationId/workflowId are deliberately ignored: the step can only
 * ever write the state of the workflow it runs in.
 */
function scopeFromContext(input: StateSetInput): WorkflowStateScope | null {
  const organizationId = input._context?.organizationId;
  const workflowId = input._context?.workflowId;
  if (!(organizationId && workflowId)) {
    return null;
  }
  return { organizationId, workflowId };
}

async function runSet(input: StateSetInput): Promise<StateSetResult> {
  const scope = scopeFromContext(input);
  if (!scope) {
    return {
      success: false,
      error:
        "State Set requires the workflow execution context (organization and workflow); it can only run inside a workflow",
    };
  }

  if (input.value === undefined) {
    return { success: false, error: 'State Set requires a "value"' };
  }

  const ttl = resolveTtlSeconds(input.ttl);
  if ("error" in ttl) {
    return { success: false, error: ttl.error };
  }

  const cas = resolveExpectedVersion(input.expectedVersion);
  if ("error" in cas) {
    return { success: false, error: cas.error };
  }

  const result = await setWorkflowStateValue(scope, input.key ?? "", {
    value: coerceStateValue(input.value),
    ttlSeconds: ttl.seconds,
    expectedVersion: cas.version,
    executionId: input._context?.executionId ?? null,
  });
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    created: result.created,
    version: result.version,
  };
}

/**
 * State Set Step - write a key to this workflow's persistent state
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function stateSetStep(
  input: StateSetInput
): Promise<StateSetResult> {
  "use step";
  return withStepLogging(input, () => runSet(input));
}
// A write is never re-run: the durability layer replaying a set could bump
// the version twice and turn an idempotent overwrite into a CAS trap.
stateSetStep.maxRetries = 0;
