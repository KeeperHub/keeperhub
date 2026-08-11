import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import {
  clearExecution,
  getSuccessfulSteps,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

/**
 * KEEP-398 / KEEP-431: Reconcile spurious max-retries / step-completion-tracker
 * errors via the step-success authority.
 *
 * Background:
 *   The Workflow DevKit's post-step "step_completed" event is occasionally
 *   lost under heavy fan-in (13+ parallel reads converging into one combine).
 *   The framework then re-fires the step on resume and -- with
 *   runCodeStep.maxRetries=0 -- throws "Step ... exceeded max retries"
 *   even though the step body returned successfully and recorded its output
 *   via recordStepSuccess (called from step-handler.ts).
 *
 *   The executor.workflow.ts catch block now consults getCompletedStepOutput
 *   (tracker fast-path with DB fallback): when the error message matches the
 *   spurious shape AND a recorded success exists for the failing node, the
 *   executor treats it as success and continues downstream.
 *
 * These tests cover the predicate logic (regex shape) and the tracker fast
 * path round-trip used by the recovery decision. The DB-fallback path is
 * covered by cross-process-tracker-simulation.test.ts. A full executeWorkflow
 * integration test is intentionally out of scope: the executor module imports
 * plugin registries, metrics, logging, AsyncLocalStorage error contexts, and
 * a dynamically generated step-registry, all of which would require >200
 * lines of mocking.
 *
 * The regex constants are imported from the production module (not redefined
 * here) so any rename or pattern change in executor.workflow.ts breaks this
 * test instead of silently passing.
 */

// ---------------------------------------------------------------------------
// Predicate -- mirrors the catch-block check in executor.workflow.ts
// ---------------------------------------------------------------------------

function isSpuriousMaxRetriesError(message: string): boolean {
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(message) ||
    FAILED_AFTER_RETRIES_REGEX.test(message) ||
    NO_STEP_COMPLETION_REGEX.test(message)
  );
}

/**
 * Mirror of the executor catch-block's "should we reconcile?" decision so
 * regressions in either the predicate or tracker lookup are caught here.
 */
function shouldReconcile(
  executionId: string | undefined,
  nodeId: string,
  errorMessage: string
): { reconcile: boolean; recordedOutput: unknown } {
  const recordedOutput = executionId
    ? getSuccessfulSteps(executionId)?.get(nodeId)
    : undefined;
  return {
    reconcile:
      isSpuriousMaxRetriesError(errorMessage) && recordedOutput !== undefined,
    recordedOutput,
  };
}

// ---------------------------------------------------------------------------

describe("isSpuriousMaxRetriesError predicate", () => {
  it("matches the SDK 'exceeded max retries' shape", () => {
    expect(
      isSpuriousMaxRetriesError(
        'Step "runCodeStep" exceeded max retries (1 retry)'
      )
    ).toBe(true);
  });

  it("matches the SDK 'failed after N retries' shape (catch-path variant)", () => {
    expect(
      isSpuriousMaxRetriesError(
        'Step "runCodeStep" failed after 1 retries: ECONNRESET'
      )
    ).toBe(true);
    expect(
      isSpuriousMaxRetriesError(
        'Step "combine" failed after 0 retries: state replay mismatch'
      )
    ).toBe(true);
  });

  it("matches the SDK 'Step did not record completion' shape", () => {
    expect(
      isSpuriousMaxRetriesError(
        "Step did not record completion within timeout window"
      )
    ).toBe(true);
  });

  it("matches case-insensitively (SDK wording occasionally varies)", () => {
    expect(
      isSpuriousMaxRetriesError('Step "x" EXCEEDED MAX RETRIES (1 retry)')
    ).toBe(true);
    expect(isSpuriousMaxRetriesError("step did not record completion")).toBe(
      true
    );
  });

  it("does not match unrelated step errors", () => {
    expect(
      isSpuriousMaxRetriesError("Contract reverted: insufficient balance")
    ).toBe(false);
    expect(isSpuriousMaxRetriesError("ECONNREFUSED")).toBe(false);
    expect(isSpuriousMaxRetriesError("")).toBe(false);
  });
});

describe("step-success-tracker round-trip used by reconciliation", () => {
  const executionId = "exec-keep-398-test";
  const runCodeNodeId = "code-node-1";

  afterEach(() => {
    clearExecution(executionId);
  });

  it("returns the recorded output for a node within an execution", () => {
    recordStepSuccess(executionId, runCodeNodeId, { merged: 42 });

    const steps = getSuccessfulSteps(executionId);
    expect(steps).toBeDefined();
    expect(steps?.get(runCodeNodeId)).toEqual({ merged: 42 });
  });

  it("returns undefined when no execution has been recorded", () => {
    expect(getSuccessfulSteps("never-recorded")).toBeUndefined();
  });

  it("isolates outputs by executionId", () => {
    const otherExecutionId = "exec-other";
    recordStepSuccess(executionId, runCodeNodeId, { merged: 1 });
    recordStepSuccess(otherExecutionId, runCodeNodeId, { merged: 2 });

    expect(getSuccessfulSteps(executionId)?.get(runCodeNodeId)).toEqual({
      merged: 1,
    });
    expect(getSuccessfulSteps(otherExecutionId)?.get(runCodeNodeId)).toEqual({
      merged: 2,
    });

    clearExecution(otherExecutionId);
  });

  it("clearExecution removes only the targeted execution", () => {
    const otherExecutionId = "exec-keep-378-test-other";
    recordStepSuccess(executionId, runCodeNodeId, { kept: true });
    recordStepSuccess(otherExecutionId, runCodeNodeId, { kept: false });

    clearExecution(otherExecutionId);

    expect(getSuccessfulSteps(executionId)?.get(runCodeNodeId)).toEqual({
      kept: true,
    });
    expect(getSuccessfulSteps(otherExecutionId)).toBeUndefined();
  });

  it("preserves falsy outputs (null, 0, false, empty string)", () => {
    recordStepSuccess(executionId, "n-null", null);
    recordStepSuccess(executionId, "n-zero", 0);
    recordStepSuccess(executionId, "n-false", false);
    recordStepSuccess(executionId, "n-empty", "");

    const steps = getSuccessfulSteps(executionId);
    expect(steps?.has("n-null")).toBe(true);
    expect(steps?.get("n-null")).toBeNull();
    expect(steps?.get("n-zero")).toBe(0);
    expect(steps?.get("n-false")).toBe(false);
    expect(steps?.get("n-empty")).toBe("");
  });
});

describe("reconciliation decision used by executor catch block", () => {
  const executionId = "exec-reconcile-decision";
  const runCodeNodeId = "combine-node";

  afterEach(() => {
    clearExecution(executionId);
  });

  it("reconciles when the error is spurious AND a success was recorded", () => {
    recordStepSuccess(executionId, runCodeNodeId, { merged: 42 });

    const decision = shouldReconcile(
      executionId,
      runCodeNodeId,
      'Step "runCodeStep" exceeded max retries (1 retry)'
    );

    expect(decision.reconcile).toBe(true);
    expect(decision.recordedOutput).toEqual({ merged: 42 });
  });

  it("reconciles for the 'did not record completion' shape too", () => {
    recordStepSuccess(executionId, runCodeNodeId, { ok: 1 });

    const decision = shouldReconcile(
      executionId,
      runCodeNodeId,
      "Step did not record completion"
    );

    expect(decision.reconcile).toBe(true);
    expect(decision.recordedOutput).toEqual({ ok: 1 });
  });

  it("does not reconcile when the tracker has no recorded success", () => {
    const decision = shouldReconcile(
      executionId,
      runCodeNodeId,
      'Step "runCodeStep" exceeded max retries (1 retry)'
    );

    expect(decision.reconcile).toBe(false);
    expect(decision.recordedOutput).toBeUndefined();
  });

  it("does not reconcile for unrelated errors even with a recorded success", () => {
    recordStepSuccess(executionId, runCodeNodeId, { merged: 42 });

    const decision = shouldReconcile(
      executionId,
      runCodeNodeId,
      "TypeError: cannot read property 'x' of undefined"
    );

    expect(decision.reconcile).toBe(false);
    expect(decision.recordedOutput).toEqual({ merged: 42 });
  });

  it("does not reconcile when executionId is missing", () => {
    recordStepSuccess(executionId, runCodeNodeId, { merged: 42 });

    const decision = shouldReconcile(
      undefined,
      runCodeNodeId,
      'Step "runCodeStep" exceeded max retries (1 retry)'
    );

    expect(decision.reconcile).toBe(false);
    expect(decision.recordedOutput).toBeUndefined();
  });

  it("recovers a recorded null output (does not silently drop)", () => {
    recordStepSuccess(executionId, runCodeNodeId, null);

    const decision = shouldReconcile(
      executionId,
      runCodeNodeId,
      'Step "runCodeStep" exceeded max retries (1 retry)'
    );

    expect(decision.reconcile).toBe(true);
    expect(decision.recordedOutput).toBeNull();
  });
});
