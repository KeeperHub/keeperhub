/**
 * KEEP-398: Post-drain reconciliation pass.
 *
 * Tests the post-drain reconciler that runs after pendingTasks.drain() and
 * before computeFinalSuccess. When a result entry matches the spurious
 * max-retries error pattern AND a success row exists in workflow_execution_logs,
 * the failed entry is overridden to success and the spurious_recovery counter
 * is incremented with source="post_drain".
 *
 * The reconciler is imported as a standalone function so it can be unit-tested
 * without spinning up the full executor.
 *
 * DB-error containment is delegated to getCompletedStepOutput, which catches
 * all DB rejections internally, emits tracker_db_fallback.total{outcome=error},
 * and returns null. reconcileSpuriousFailures has no outer try/catch; a null
 * return simply skips the candidate and continues. The error containment test
 * below verifies this delegation path end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFetchSingle, mockIncrementCounter } = vi.hoisted(() => ({
  mockFetchSingle: vi.fn(),
  mockIncrementCounter: vi.fn(),
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
    incrementCounter: mockIncrementCounter,
    recordLatency: vi.fn(),
  }),
}));

import { clearOutputCache } from "@/lib/workflow/executor/get-completed-step-output";
import type { ExecutionResult } from "@/lib/workflow/executor/spurious-recovery";
import { reconcileSpuriousFailures } from "@/lib/workflow/executor/spurious-recovery";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";

describe("reconcileSpuriousFailures (KEEP-398 post-drain pass)", () => {
  const executionId = "exec-keep-398-post-drain";
  const nodeId = "combine-node-1";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFetchSingle.mockReset();
    mockIncrementCounter.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  describe("in-catch fast-path: tracker already populated (20% case)", () => {
    it("overrides failed result from tracker when error matches spurious shape", async () => {
      recordStepSuccess(executionId, nodeId, { merged: 42 });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ merged: 42 });
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.objectContaining({ source: "post_drain" })
      );
      expect(mockFetchSingle).not.toHaveBeenCalled();
    });

    it("overrides for 'failed after N retries' shape", async () => {
      recordStepSuccess(executionId, nodeId, { ok: true });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "combine" failed after 0 retries: state replay mismatch',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
    });

    it("overrides for 'Step did not record completion' shape", async () => {
      recordStepSuccess(executionId, nodeId, { result: 99 });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: "Step did not record completion within timeout window",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
    });
  });

  describe("prod KEEP-398 repro: tracker empty, DB has success row", () => {
    it("overrides failed result from DB when tracker is empty but DB row exists", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { mergedFromDb: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ mergedFromDb: true });
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.objectContaining({ source: "post_drain" })
      );
    });

    it("increments spurious_recovery.total exactly once per recovered node", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { x: 1 } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      const recoveryCalls = mockIncrementCounter.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "workflow.executor.spurious_recovery.total"
      );
      expect(recoveryCalls).toHaveLength(1);
    });

    it("recovers multiple failed nodes in the same pass", async () => {
      const nodeB = "combine-node-2";
      mockFetchSingle.mockResolvedValue({ outputRaw: { db: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
        [nodeB]: {
          success: false,
          error: "Step did not record completion within timeout window",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeB].success).toBe(true);
      const recoveryCalls = mockIncrementCounter.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "workflow.executor.spurious_recovery.total"
      );
      expect(recoveryCalls).toHaveLength(2);
    });
  });

  describe("error containment: DB error on one candidate does not abort the pass", () => {
    it("skips erroring candidate and continues with the next one", async () => {
      const nodeB = "combine-node-2";

      // First call rejects (DB blip for nodeId); second resolves (nodeB recovers).
      // The rejection is caught inside getCompletedStepOutput which evicts the
      // cache, increments tracker_db_fallback.total{outcome=error}, and returns
      // null -- so reconcileSpuriousFailures skips nodeId and proceeds to nodeB.
      mockFetchSingle
        .mockRejectedValueOnce(new Error("Pool exhausted"))
        .mockResolvedValueOnce({ outputRaw: { recovered: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
        [nodeB]: {
          success: false,
          error: "Step did not record completion within timeout window",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      // nodeId: DB rejected -> null returned -> entry not recovered
      expect(results[nodeId].success).toBe(false);
      // nodeB: DB succeeded -> entry recovered
      expect(results[nodeB].success).toBe(true);
      // The error counter from getCompletedStepOutput fires on the DB rejection
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.tracker_db_fallback.total",
        expect.objectContaining({ outcome: "error" })
      );
      // The recovery counter fires for nodeB
      expect(mockIncrementCounter).toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.objectContaining({ source: "post_drain" })
      );
    });
  });

  describe("negative: failed entry stands when no success evidence exists", () => {
    it("does not override when DB has no success row for the node", async () => {
      mockFetchSingle.mockResolvedValue(null);

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.anything()
      );
    });

    it("does not override for unrelated errors even when DB has a success row", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { ok: true } });

      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: "Contract reverted: insufficient balance",
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockIncrementCounter).not.toHaveBeenCalledWith(
        "workflow.executor.spurious_recovery.total",
        expect.anything()
      );
    });

    it("does not modify already-successful entries", async () => {
      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: true,
          data: { alreadyGood: true },
        },
      };

      await reconcileSpuriousFailures({ executionId, results });

      expect(results[nodeId].success).toBe(true);
      expect(results[nodeId].data).toEqual({ alreadyGood: true });
      expect(mockFetchSingle).not.toHaveBeenCalled();
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not reconcile when executionId is undefined", async () => {
      const results: Record<string, ExecutionResult> = {
        [nodeId]: {
          success: false,
          error: 'Step "runCodeStep" exceeded max retries (1 retry)',
        },
      };

      await reconcileSpuriousFailures({ executionId: undefined, results });

      expect(results[nodeId].success).toBe(false);
      expect(mockFetchSingle).not.toHaveBeenCalled();
      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });

    it("does not modify the counter when results object is empty", async () => {
      const results: Record<string, ExecutionResult> = {};

      await reconcileSpuriousFailures({ executionId, results });

      expect(mockIncrementCounter).not.toHaveBeenCalled();
    });
  });
});
