/**
 * Executable step function for the State Get action (KEEP-1036, #2288).
 *
 * Reads one key from the executing workflow's own persistent state. The scope
 * comes from the execution context, never from config - the same rule the
 * circuit-breaker steps apply - so a workflow can only ever read its own keys
 * and there is no cross-workflow or cross-org path.
 */
import "server-only";

import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import {
  getWorkflowStateValue,
  type WorkflowStateScope,
} from "@/lib/workflow/nodes/workflow-state/store";

export type StateGetInput = StepInput & {
  key?: string;
};

type StateGetResult =
  | { success: true; exists: true; value: unknown; version: number }
  | { success: true; exists: false; value: null }
  | { success: false; error: string };

/**
 * Resolve the (org, workflow) scope from the execution context. Config values
 * named organizationId/workflowId are deliberately ignored: the step can only
 * ever touch the state of the workflow it runs in.
 */
function scopeFromContext(input: StateGetInput): WorkflowStateScope | null {
  const organizationId = input._context?.organizationId;
  const workflowId = input._context?.workflowId;
  if (!(organizationId && workflowId)) {
    return null;
  }
  return { organizationId, workflowId };
}

async function runGet(input: StateGetInput): Promise<StateGetResult> {
  const scope = scopeFromContext(input);
  if (!scope) {
    return {
      success: false,
      error:
        "State Get requires the workflow execution context (organization and workflow); it can only run inside a workflow",
    };
  }

  const result = await getWorkflowStateValue(scope, input.key ?? "");
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (!result.exists) {
    return { success: true, exists: false, value: null };
  }
  return {
    success: true,
    exists: true,
    value: result.value,
    version: result.version,
  };
}

/**
 * State Get Step - read a key from this workflow's persistent state
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function stateGetStep(
  input: StateGetInput
): Promise<StateGetResult> {
  "use step";
  return withStepLogging(input, () => runGet(input));
}
stateGetStep.maxRetries = 0;
