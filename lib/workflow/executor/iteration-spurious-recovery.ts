import { getCompletedStepOutput } from "@/lib/workflow/executor/get-completed-step-output";
import { awaitCompletedStepOutputAtIterationStep } from "@/lib/workflow/executor/get-completed-step-output.step";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";

/**
 * Spurious-max-retries recovery poll window. When the framework re-fires a
 * step after a lost completion event and throws before the step's success row
 * is committed, the real success lands ~0.3-0.5s later. The catch handler
 * polls the step authority for up to this window before falling back to
 * nullifying the node.
 *
 * A duplicate delivery of a step whose first attempt is still executing throws
 * the same error; that success lands when the attempt finishes. While the node
 * still has a 'running' row the poll extends up to the in-flight window.
 */
export const SPURIOUS_RECOVERY_POLL_TIMEOUT_MS = 3000;
export const SPURIOUS_RECOVERY_POLL_INTERVAL_MS = 250;
export const SPURIOUS_RECOVERY_INFLIGHT_TIMEOUT_MS = 60_000;

function isSpuriousShape(errorMessage: string): boolean {
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(errorMessage) ||
    FAILED_AFTER_RETRIES_REGEX.test(errorMessage) ||
    NO_STEP_COMPLETION_REGEX.test(errorMessage)
  );
}

/**
 * Recover the output of a For Each body step that threw after its body
 * recorded a success. Reads the iteration's success row once; when the error
 * has a spurious max-retries shape and no row exists yet, waits for it, since
 * a duplicate delivery throws while the first attempt is still running.
 * Returns null when no success row exists, so a real failure stays a failure.
 */
export async function resolveIterationSpuriousRecovery(params: {
  executionId: string;
  nodeId: string;
  forEachNodeId: string;
  iterationIndex: number;
  errorMessage: string;
  onPollError: (error: Error) => void;
}): Promise<{ output: unknown } | null> {
  const { executionId, nodeId, forEachNodeId, iterationIndex, errorMessage } =
    params;

  const recovered = await getCompletedStepOutput(executionId, nodeId, {
    forEachNodeId,
    iterationIndex,
  });
  if (recovered) {
    return { output: recovered.output };
  }
  if (!isSpuriousShape(errorMessage)) {
    return null;
  }

  try {
    const polled = await awaitCompletedStepOutputAtIterationStep(
      executionId,
      nodeId,
      forEachNodeId,
      iterationIndex,
      SPURIOUS_RECOVERY_POLL_TIMEOUT_MS,
      SPURIOUS_RECOVERY_POLL_INTERVAL_MS,
      SPURIOUS_RECOVERY_INFLIGHT_TIMEOUT_MS
    );
    return polled ? { output: polled.outputRaw } : null;
  } catch (pollError) {
    params.onPollError(
      pollError instanceof Error ? pollError : new Error(String(pollError))
    );
    return null;
  }
}
