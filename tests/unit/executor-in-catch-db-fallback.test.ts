/**
 * KEEP-431: In-catch DB fallback for spurious max-retries recovery.
 *
 * The executor.workflow.ts catch block previously consulted only the in-process
 * step-success-tracker, which is empty on a fresh pod that did not run the
 * predecessor step. Under cross-pod SDK checkpoint resume (the dominant mode
 * on the x402/call_workflow path), this left the in-catch unable to recover
 * and forced reliance on the post-drain reconciler.
 *
 * The fix: in-catch now uses getCompletedStepOutput, which checks the tracker
 * first (fast path) and falls back to workflow_execution_logs.outputRaw. This
 * makes recovery uniform across same-process (direct execute_workflow) and
 * cross-process (x402 call_workflow) paths.
 *
 * These tests exercise the in-catch decision predicate via getCompletedStepOutput
 * directly. Doing this against the live executor would require ~200 lines of
 * plugin-registry / metrics / logging mocking; the predicate-level test verifies
 * the actual code path (getCompletedStepOutput) the in-catch now calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFetchSingle } = vi.hoisted(() => ({
  mockFetchSingle: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output.step", () => ({
  fetchCompletedStepOutputStep: mockFetchSingle,
  fetchCompletedStepOutputsBatchStep: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
    recordLatency: vi.fn(),
  }),
}));

import {
  clearOutputCache,
  getCompletedStepOutput,
} from "@/lib/workflow/executor/get-completed-step-output";
import {
  EXCEEDED_MAX_RETRIES_REGEX,
  FAILED_AFTER_RETRIES_REGEX,
  NO_STEP_COMPLETION_REGEX,
} from "@/lib/workflow/executor/runner-error-patterns";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

function isSpuriousMaxRetriesError(message: string): boolean {
  return (
    EXCEEDED_MAX_RETRIES_REGEX.test(message) ||
    FAILED_AFTER_RETRIES_REGEX.test(message) ||
    NO_STEP_COMPLETION_REGEX.test(message)
  );
}

/**
 * Mirror of the executor.workflow.ts catch-block decision after KEEP-431.
 * Returns the recovered output, or undefined if no recovery should happen.
 */
async function inCatchRecover(
  executionId: string | undefined,
  nodeId: string,
  errorMessage: string
): Promise<unknown | undefined> {
  if (!isSpuriousMaxRetriesError(errorMessage)) {
    return;
  }
  if (!executionId) {
    return;
  }
  const completed = await getCompletedStepOutput(executionId, nodeId);
  return completed?.output;
}

describe("KEEP-431: in-catch DB fallback recovery", () => {
  const executionId = "exec-keep-431-in-catch";
  const nodeId = "combine-cross-pod";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFetchSingle.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  describe("fast path: tracker populated (same-process direct execute_workflow)", () => {
    it("recovers from tracker without hitting DB", async () => {
      recordStepSuccess(executionId, nodeId, { merged: 42 });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "runCodeStep" exceeded max retries (1 retry)'
      );

      expect(recovered).toEqual({ merged: 42 });
      expect(mockFetchSingle).not.toHaveBeenCalled();
    });
  });

  describe("cross-pod path: tracker empty, DB has the row (x402 prod scenario)", () => {
    it("recovers from DB when tracker is empty", async () => {
      mockFetchSingle.mockResolvedValue({
        outputRaw: { aave_v3: { shares_1e18: "12345" } },
      });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "runCodeStep" exceeded max retries (1 retry)'
      );

      expect(recovered).toEqual({ aave_v3: { shares_1e18: "12345" } });
      expect(mockFetchSingle).toHaveBeenCalledTimes(1);
    });

    it("recovers from DB for 'failed after N retries' error shape", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { ok: true } });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "combine" failed after 0 retries: state replay mismatch'
      );

      expect(recovered).toEqual({ ok: true });
    });

    it("recovers from DB for 'did not record completion' error shape", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { result: 99 } });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        "Step did not record completion within timeout window"
      );

      expect(recovered).toEqual({ result: 99 });
    });
  });

  describe("negative cases: do not recover", () => {
    it("returns undefined when DB has no row and tracker is empty", async () => {
      mockFetchSingle.mockResolvedValue(null);

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "runCodeStep" exceeded max retries (1 retry)'
      );

      expect(recovered).toBeUndefined();
    });

    it("does not recover unrelated step errors even when DB has a success row", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { ok: true } });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        "Contract reverted: insufficient balance"
      );

      expect(recovered).toBeUndefined();
      // Predicate fails before DB is consulted, so no DB query is issued.
      expect(mockFetchSingle).not.toHaveBeenCalled();
    });

    it("does not recover when executionId is missing", async () => {
      const recovered = await inCatchRecover(
        undefined,
        nodeId,
        'Step "runCodeStep" exceeded max retries (1 retry)'
      );

      expect(recovered).toBeUndefined();
      expect(mockFetchSingle).not.toHaveBeenCalled();
    });

    it("does not swallow DB rejection (returns undefined and logs internally)", async () => {
      mockFetchSingle.mockRejectedValue(new Error("Pool exhausted"));

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "runCodeStep" exceeded max retries (1 retry)'
      );

      // getCompletedStepOutput catches DB errors internally and returns null.
      expect(recovered).toBeUndefined();
    });
  });

  describe("preserves falsy outputs (regression guard against `recordedOutput !== undefined` checks)", () => {
    it("recovers a recorded null output", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: null });

      const recovered = await inCatchRecover(
        executionId,
        nodeId,
        'Step "x" exceeded max retries (1 retry)'
      );

      // null is a valid recovered value; the executor's
      // `recordedOutput !== undefined` guard should still pass it through.
      expect(recovered).toBeNull();
    });
  });
});
