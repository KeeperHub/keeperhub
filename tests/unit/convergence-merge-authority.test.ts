/**
 * KEEP-395: Cross-process convergence merge authority.
 *
 * Tests that `mergeFromAuthority` correctly falls back to the DB when the
 * in-process step-success-tracker is empty (simulating a cross-pod SDK resume
 * where predecessors ran on a different worker process).
 *
 * The in-process tracker is cleared between "predecessor completion" and the
 * convergence merge to simulate the prod cross-process boundary.
 *
 * The batch helper `getCompletedStepOutputs` is used internally; tests mock
 * `fetchCompletedStepOutputsBatchStep` accordingly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFetchBatch, mockIncrementCounter, mockRecordLatency } = vi.hoisted(
  () => ({
    mockFetchBatch: vi.fn(),
    mockIncrementCounter: vi.fn(),
    mockRecordLatency: vi.fn(),
  })
);

vi.mock("@/lib/workflow/executor/get-completed-step-output.step", () => ({
  fetchCompletedStepOutputStep: vi.fn(),
  fetchCompletedStepOutputsBatchStep: mockFetchBatch,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "workflow_engine" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: mockIncrementCounter,
    recordLatency: mockRecordLatency,
  }),
}));

import {
  mergeFromAuthority,
  type NodeOutputs,
} from "@/lib/workflow/executor/convergence-tracker-merge";
import { clearOutputCache } from "@/lib/workflow/executor/get-completed-step-output";
import {
  clearExecution,
  recordStepSuccess,
} from "@/lib/workflow/executor/step-success-tracker";
import type { WorkflowNode } from "@/lib/workflow/store";

function makeNode(id: string, label?: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: label ?? id,
      config: {},
    },
  } as unknown as WorkflowNode;
}

const getNodeName = (n: WorkflowNode): string =>
  (n.data.label as string) ?? n.id;

describe("mergeFromAuthority (KEEP-395 cross-process DB fallback)", () => {
  const executionId = "exec-keep-395-authority";

  beforeEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
    mockFetchBatch.mockReset();
    mockIncrementCounter.mockReset();
    mockRecordLatency.mockReset();
  });

  afterEach(() => {
    clearOutputCache(executionId);
    clearExecution(executionId);
  });

  it("returns original outputs unchanged when executionId is undefined", async () => {
    const outputs: NodeOutputs = { a: { label: "A", data: 1 } };

    const result = await mergeFromAuthority({
      outputs,
      executionId: undefined,
      predecessorIds: ["a"],
      nodeMap: new Map([["a", makeNode("a")]]),
      getNodeName,
    });

    expect(result).toBe(outputs);
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it("returns original outputs unchanged when predecessorIds is empty", async () => {
    const outputs: NodeOutputs = { a: { label: "A", data: 1 } };

    const result = await mergeFromAuthority({
      outputs,
      executionId,
      predecessorIds: [],
      nodeMap: new Map([["a", makeNode("a")]]),
      getNodeName,
    });

    expect(result).toBe(outputs);
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  describe("tracker hit (same process)", () => {
    it("uses tracker data but still issues the batch step so replays match", async () => {
      recordStepSuccess(executionId, "predA", { rate: 4.5 });

      const outputs: NodeOutputs = {
        predA: { label: "A", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["predA"],
        nodeMap: new Map([["predA", makeNode("predA", "A")]]),
        getNodeName,
      });

      expect(result.predA.data).toEqual({ rate: 4.5 });
      // The tracker is process-local and empty on a cold pod, so letting it
      // decide whether the step runs makes the step sequence differ between
      // replays of the same convergence.
      expect(mockFetchBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("DB authority: cross-process resume simulation", () => {
    it("prod KEEP-395 repro: 9-fan-in, tracker empty, DB returns all 9 predecessor outputs with exactly 1 query", async () => {
      const predIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));

      const outputs: NodeOutputs = Object.fromEntries(
        predIds.map((id) => [id, { label: id, data: null }])
      );

      mockFetchBatch.mockResolvedValue(
        predIds.map((nodeId) => ({
          nodeId,
          outputRaw: { value: "result-for-db" },
        }))
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
        expect(result[id].data).toEqual({ value: "result-for-db" });
        expect(result[id].data).not.toBeNull();
      }
    });

    it("stale closure null is overridden by DB output for the missing predecessor", async () => {
      mockFetchBatch.mockResolvedValue([
        { nodeId: "sparkPosOut", outputRaw: { sparkPos: 1234 } },
        { nodeId: "otherPred", outputRaw: { ok: true } },
      ]);

      const outputs: NodeOutputs = {
        sparkPosOut: { label: "Spark Pos", data: null },
        otherPred: { label: "Other", data: { ok: true } },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["sparkPosOut", "otherPred"],
        nodeMap: new Map([
          ["sparkPosOut", makeNode("sparkPosOut", "Spark Pos")],
          ["otherPred", makeNode("otherPred", "Other")],
        ]),
        getNodeName,
      });

      expect(result.sparkPosOut.data).toEqual({ sparkPos: 1234 });
    });

    it("partial cross-process: tracker has some, DB fills the rest in 1 query", async () => {
      const predIds = ["pA", "pB", "pC"];
      const nodeMap = new Map(predIds.map((id) => [id, makeNode(id)]));

      recordStepSuccess(executionId, "pA", { fromTracker: true });

      mockFetchBatch.mockResolvedValue([
        { nodeId: "pB", outputRaw: { fromDb: true } },
        { nodeId: "pC", outputRaw: { fromDb: true } },
      ]);

      const outputs: NodeOutputs = {
        pA: { label: "pA", data: null },
        pB: { label: "pB", data: null },
        pC: { label: "pC", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: predIds,
        nodeMap,
        getNodeName,
      });

      expect(result.pA.data).toEqual({ fromTracker: true });
      expect(result.pB.data).toEqual({ fromDb: true });
      expect(result.pC.data).toEqual({ fromDb: true });
      expect(mockFetchBatch).toHaveBeenCalledTimes(1);
    });

    it("output_raw flows through unredacted: apiKey field is preserved", async () => {
      const rawOutput = { apiKey: "0xSECRET", amount: 500 };

      mockFetchBatch.mockResolvedValue([
        { nodeId: "predA", outputRaw: rawOutput },
      ]);

      const outputs: NodeOutputs = {
        predA: { label: "A", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["predA"],
        nodeMap: new Map([["predA", makeNode("predA", "A")]]),
        getNodeName,
      });

      expect((result.predA.data as Record<string, unknown>)?.apiKey).toBe(
        "0xSECRET"
      );
    });
  });

  describe("negative: DB also has no success row", () => {
    it("closure value stands when both tracker and DB miss", async () => {
      mockFetchBatch.mockResolvedValue([]);

      const closureValue = { staleButOnlyValue: true };
      const outputs: NodeOutputs = {
        pred: { label: "P", data: closureValue },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["pred"],
        nodeMap: new Map([["pred", makeNode("pred", "P")]]),
        getNodeName,
      });

      expect(result.pred.data).toBe(closureValue);
    });

    it("returns original outputs object (identity) when no merge occurred", async () => {
      mockFetchBatch.mockResolvedValue([]);

      const outputs: NodeOutputs = {
        pred: { label: "P", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: ["pred"],
        nodeMap: new Map([["pred", makeNode("pred", "P")]]),
        getNodeName,
      });

      expect(result).toBe(outputs);
    });
  });

  describe("sanitised node IDs", () => {
    it("produces sanitised key in merged result for IDs with dashes and dots", async () => {
      const rawId = "node-with-dashes.and.dots";
      const sanitized = "node_with_dashes_and_dots";

      mockFetchBatch.mockResolvedValue([
        { nodeId: rawId, outputRaw: { dbResult: true } },
      ]);

      const outputs: NodeOutputs = {
        [sanitized]: { label: "raw", data: null },
      };

      const result = await mergeFromAuthority({
        outputs,
        executionId,
        predecessorIds: [rawId],
        nodeMap: new Map([[rawId, makeNode(rawId, "raw")]]),
        getNodeName,
      });

      expect(result[sanitized].data).toEqual({ dbResult: true });
    });
  });
});
