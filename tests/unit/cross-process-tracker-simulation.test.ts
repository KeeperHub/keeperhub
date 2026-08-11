/**
 * Cross-process step-tracker simulation -- regression canary for KEEP-395 and KEEP-398.
 *
 * This test is the primary regression-prevention canary. It simulates the prod
 * cross-process timing by making the in-process tracker appear empty for a
 * designated nodeId (as it would be on a fresh pod that did not run that step),
 * then asserts that the new DB-authority code path returns the correct value
 * while the old in-process-only code path would have returned null/undefined.
 *
 * If this test goes red, the cross-process fix has regressed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFetchSingle, mockFetchBatch } = vi.hoisted(() => ({
  mockFetchSingle: vi.fn(),
  mockFetchBatch: vi.fn(),
}));

vi.mock("@/lib/workflow/executor/get-completed-step-output.step", () => ({
  fetchCompletedStepOutputStep: mockFetchSingle,
  fetchCompletedStepOutputsBatchStep: mockFetchBatch,
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
  mergeFromAuthority,
  mergeFromTracker,
  type NodeOutputs,
} from "@/lib/workflow/executor/convergence-tracker-merge";
import {
  clearOutputCache,
  getCompletedStepOutput,
} from "@/lib/workflow/executor/get-completed-step-output";
import {
  clearExecution,
  getSuccessfulSteps,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";
import type { WorkflowNode } from "@/lib/workflow/store";

function makeNode(id: string, label?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { type: "action", label: label ?? id, config: {} },
  } as unknown as WorkflowNode;
}

const getNodeName = (n: WorkflowNode): string =>
  (n.data.label as string) ?? n.id;

/**
 * Simulate old code path: in-process tracker only, no DB fallback.
 * Returns undefined when tracker is empty (the pre-fix behaviour).
 */
function oldCodePath_getOutput(
  executionId: string,
  nodeId: string
): unknown | undefined {
  return getSuccessfulSteps(executionId)?.get(nodeId);
}

describe("KEEP-395/398 cross-process tracker simulation -- regression canary", () => {
  const executionId = "exec-cross-process-canary";
  const missingNodeId = "vdij1o81aos88rx4pve0q"; // prod node ID from incident

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFetchSingle.mockReset();
    mockFetchBatch.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  it("old code path returns undefined when tracker is empty (demonstrates the bug)", () => {
    // Simulate cross-process: step ran on pod A, we are now on pod B.
    // Tracker is empty -- recordStepSuccess was never called on this pod.
    const result = oldCodePath_getOutput(executionId, missingNodeId);

    expect(result).toBeUndefined();
  });

  it("new code path (getCompletedStepOutput) returns DB value when tracker is empty", async () => {
    const prodOutput = { sparkPos: 1234, timestamp: 1_716_123_199_442 };
    mockFetchSingle.mockResolvedValue({ outputRaw: prodOutput });

    const result = await getCompletedStepOutput(executionId, missingNodeId);

    expect(result).not.toBeNull();
    expect(result?.source).toBe("db");
    expect(result?.output).toEqual(prodOutput);
  });

  it("new code path is faster when tracker hits (no DB query on same-process run)", async () => {
    const trackerOutput = { fast: true };
    recordStepSuccess(executionId, missingNodeId, trackerOutput);

    const result = await getCompletedStepOutput(executionId, missingNodeId);

    expect(result?.source).toBe("tracker");
    expect(result?.output).toEqual(trackerOutput);
    expect(mockFetchSingle).not.toHaveBeenCalled();
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it("output_raw flows through unredacted: sensitive field is not replaced with [REDACTED]", async () => {
    const rawOutput = { apiKey: "0xSECRET", amount: 100 };
    mockFetchSingle.mockResolvedValue({ outputRaw: rawOutput });

    const result = await getCompletedStepOutput(executionId, missingNodeId);

    expect(result?.source).toBe("db");
    expect((result?.output as Record<string, unknown>)?.apiKey).toBe(
      "0xSECRET"
    );
  });

  describe("KEEP-395: 9-fan-in convergence across process boundary", () => {
    it("mergeFromAuthority fills all 9 predecessor slots from DB with exactly 1 query", async () => {
      const predIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));

      // Closure outputs: all null (stale snapshot from SDK checkpoint)
      const outputs: NodeOutputs = Object.fromEntries(
        predIds.map((id) => [id, { label: id, data: null }])
      );

      // DB has all 9 success rows
      mockFetchBatch.mockResolvedValue(
        predIds.map((nodeId) => ({ nodeId, outputRaw: { value: 42 } }))
      );

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: predIds,
        nodeMap,
        getNodeName,
      });

      expect(mockFetchBatch).toHaveBeenCalledTimes(1);
      for (const id of predIds) {
        expect(result[id].data).not.toBeNull();
        expect(result[id].data).toEqual({ value: 42 });
      }
    });

    it("under OLD mergeFromTracker with empty tracker: all predecessors remain null (bug demonstration)", () => {
      const predIds = ["p1", "p2", "p3"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));
      const outputs: NodeOutputs = Object.fromEntries(
        predIds.map((id) => [id, { label: id, data: null }])
      );

      // Tracker returns undefined (empty, cross-process scenario)
      const result: NodeOutputs = mergeFromTracker({
        outputs,
        executionId,
        predecessorIds: predIds,
        nodeMap,
        getTracker: () => undefined,
        getNodeName,
      });

      // The old code path: when tracker is undefined, returns original stale closure unchanged
      expect(result).toBe(outputs);
      for (const id of predIds) {
        expect(result[id].data).toBeNull();
      }
    });
  });

  describe("KEEP-398: post-drain spurious recovery across process boundary", () => {
    it("tracker empty + DB miss: spurious error is NOT recovered (correct negative)", async () => {
      mockFetchSingle.mockResolvedValue(null);

      const result = await getCompletedStepOutput(executionId, missingNodeId);

      expect(result).toBeNull();
    });

    it("tracker empty + DB hit: spurious error CAN be recovered via DB authority", async () => {
      const dbOutput = { combine: "result", items: [1, 2, 3] };
      mockFetchSingle.mockResolvedValue({ outputRaw: dbOutput });

      const result = await getCompletedStepOutput(executionId, missingNodeId);

      expect(result?.output).toEqual(dbOutput);
      expect(result?.source).toBe("db");
    });
  });

  describe("single-flight guarantee under concurrent convergence nodes", () => {
    it("multiple convergence nodes querying the same predecessor via getCompletedStepOutput issue exactly 1 DB call", async () => {
      mockFetchSingle.mockResolvedValue({ outputRaw: { shared: true } });

      const [r1, r2, r3] = await Promise.all([
        getCompletedStepOutput(executionId, missingNodeId),
        getCompletedStepOutput(executionId, missingNodeId),
        getCompletedStepOutput(executionId, missingNodeId),
      ]);

      expect(mockFetchSingle).toHaveBeenCalledTimes(1);
      expect(r1?.output).toEqual({ shared: true });
      expect(r2?.output).toEqual({ shared: true });
      expect(r3?.output).toEqual({ shared: true });
    });
  });
});
