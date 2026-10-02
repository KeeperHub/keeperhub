/**
 * Executable step function for the State Get action (#2288).
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
  scopeFromStepContext,
} from "@/lib/workflow/nodes/workflow-state/store";

export type StateGetInput = StepInput & {
  key?: string;
};

type StateGetResult =
  | { success: true; exists: true; value: unknown; version: number }
  | { success: true; exists: false; value: null; version: 0 }
  | { success: false; error: string };

async function runGet(input: StateGetInput): Promise<StateGetResult> {
  const scope = scopeFromStepContext(input._context);
  if (!scope) {
    return {
      success: false,
      error:
        "State Get requires the workflow execution context; it can only run inside a workflow",
    };
  }

  const result = await getWorkflowStateValue(scope, input.key ?? "");
  if (!result.success) {
    return { success: false, error: result.error };
  }
  if (!result.exists) {
    // version 0 on a miss: a downstream {{@...:State Get.version}} reference
    // resolves, and fed to State Set's expectedVersion it means "only write if
    // the key still does not exist", so the first write is protected too.
    return { success: true, exists: false, value: null, version: 0 };
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
